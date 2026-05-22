import assert from 'node:assert/strict'
import test from 'node:test'
import { createDashboardApiKey, loadDashboardSnapshot, revokeDashboardApiKey, sendChat } from '../src/api.js'

test('loadDashboardSnapshot returns server data and does not use demo fallback', async () => {
  const snapshot = {
    account: { id: 'acct-1', displayName: 'Server Account', status: 'active' },
    balanceMicroUsd: 1,
    todaySpendMicroUsd: 0,
    baseUrl: 'https://api.mykey.example',
    apiKeys: [],
    channels: [],
    routingRules: [],
    usage: [],
    modelQuality: [],
    creditRequests: [],
  }

  const loaded = await loadDashboardSnapshot(async () => Response.json(snapshot))

  assert.equal(loaded.account.displayName, 'Server Account')
})

test('loadDashboardSnapshot throws on unauthenticated or failed dashboard API responses', async () => {
  await assert.rejects(
    () => loadDashboardSnapshot(async () => Response.json({ error: { code: 'dashboard_auth_required' } }, { status: 401 })),
    /dashboard_api_failed:401/
  )

  await assert.rejects(
    () => loadDashboardSnapshot(async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })),
    /dashboard_api_invalid_response:200/
  )

  await assert.rejects(
    () =>
      loadDashboardSnapshot(async () => {
        throw new Error('network down')
      }),
    /network down/
  )
})

test('createDashboardApiKey posts to the dashboard API and returns the one-time raw key', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const response = {
    id: 'key-1',
    name: 'Claude Code',
    raw_key: 'sk-mykey_live_once',
    prefix: 'sk-mykey_live',
    last4: 'once',
    status: 'active',
    created_at: '2026-05-21T00:00:00Z',
  }

  const created = await createDashboardApiKey('Claude Code', async (path: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: String(path), init })
    return Response.json(response, { status: 201 })
  })

  assert.equal(calls[0].path, '/dashboard/api-keys')
  assert.equal(calls[0].init?.method, 'POST')
  assert.equal(calls[0].init?.credentials, 'include')
  assert.equal(calls[0].init?.headers?.['content-type' as keyof HeadersInit], 'application/json')
  assert.equal(calls[0].init?.body, JSON.stringify({ name: 'Claude Code' }))
  assert.equal(created.rawKey, 'sk-mykey_live_once')
  assert.equal(created.key.name, 'Claude Code')
  assert.equal(created.key.prefix, 'sk-mykey_live')
  assert.equal(created.key.last4, 'once')
})

test('revokeDashboardApiKey posts to the scoped revoke endpoint', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = []

  const revoked = await revokeDashboardApiKey('key-1', async (path: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: String(path), init })
    return Response.json({ id: 'key-1', status: 'revoked', revoked_at: '2026-05-21T00:00:00Z' })
  })

  assert.equal(calls[0].path, '/dashboard/api-keys/key-1/revoke')
  assert.equal(calls[0].init?.method, 'POST')
  assert.equal(calls[0].init?.credentials, 'include')
  assert.equal(revoked.id, 'key-1')
  assert.equal(revoked.status, 'revoked')
})

test('sendChat uses dashboard chat completions before falling back to Anthropic messages', async () => {
  const calls: Array<{ path: string; body: any }> = []

  const result = await sendChat('deepseek-v4-pro', 'hello', async (path: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: String(path), body: JSON.parse(String(init?.body)) })
    return Response.json({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
  })

  assert.equal(result.text, 'ok')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, '/dashboard/chat/completions')
  assert.deepEqual(calls[0].body, {
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: 'hello' }],
  })
})

test('sendChat falls back to dashboard messages for Anthropic-routed models', async () => {
  const calls: Array<{ path: string; body: any }> = []

  const result = await sendChat('claude-3-5-sonnet', 'hello', async (path: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: String(path), body: JSON.parse(String(init?.body)) })
    if (String(path) === '/dashboard/chat/completions') {
      return Response.json({ error: { code: 'route_provider_adapter_mismatch' } }, { status: 503 })
    }
    return Response.json({
      content: [{ type: 'text', text: 'anthropic ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  })

  assert.equal(result.text, 'anthropic ok')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].path, '/dashboard/chat/completions')
  assert.equal(calls[1].path, '/dashboard/messages')
})
