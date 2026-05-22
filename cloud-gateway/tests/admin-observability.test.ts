import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryGatewayStore } from '../src/db/store.js'
import { createGatewayApp } from '../src/index.js'
import { encryptProviderToken } from '../src/vault/provider-tokens.js'

function appOptions(store: InMemoryGatewayStore, masterKeys?: Record<string, Uint8Array>) {
  return {
    store,
    pepper: 'obs-pepper',
    adminToken: 'admin-secret',
    baseUrl: 'https://dashboard.mykey.example',
    masterKeys,
    now: () => '2026-05-20T00:00:00Z',
  }
}

function seedWithUsage() {
  return new InMemoryGatewayStore({
    baseUrl: 'https://api.mykey.example',
    accounts: [
      {
        id: 'acct-a',
        displayName: 'Account A',
        status: 'active',
        accountGroup: 'friends',
        balanceMicroUsd: 1_000_000,
        reservedMicroUsd: 0,
        defaultProvider: 'openai',
        createdAt: '2026-05-19T00:00:00Z',
        updatedAt: '2026-05-19T00:00:00Z',
      },
      {
        id: 'acct-b',
        displayName: 'Account B',
        status: 'active',
        accountGroup: 'friends',
        balanceMicroUsd: 500_000,
        reservedMicroUsd: 0,
        defaultProvider: 'openai',
        createdAt: '2026-05-19T00:00:00Z',
        updatedAt: '2026-05-19T00:00:00Z',
      },
    ],
    usage: [
      {
        id: 'log-a1',
        accountId: 'acct-a',
        createdAt: '2026-05-20T10:00:00Z',
        provider: 'openai',
        model: 'gpt-4.1-mini',
        endpoint: '/v1/responses',
        statusCode: 200,
        latencyMs: 800,
        inputTokens: 100,
        outputTokens: 200,
        totalTokens: 300,
        sellCostMicroUsd: 50,
      },
      {
        id: 'log-b1',
        accountId: 'acct-b',
        createdAt: '2026-05-20T11:00:00Z',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        endpoint: '/v1/messages',
        statusCode: 200,
        latencyMs: 600,
        inputTokens: 40,
        outputTokens: 25,
        totalTokens: 65,
        sellCostMicroUsd: 495,
      },
      {
        id: 'log-a2',
        accountId: 'acct-a',
        createdAt: '2026-05-20T12:00:00Z',
        provider: 'openai',
        model: 'gpt-4.1-mini',
        endpoint: '/v1/responses',
        statusCode: 429,
        latencyMs: 5,
        sellCostMicroUsd: 0,
        errorCode: 'account_rate_limited',
      },
    ],
  })
}

test('GET /admin/usage requires admin auth', async () => {
  const store = seedWithUsage()
  const app = createGatewayApp(appOptions(store))
  const unauthorized = await app.fetch(new Request('https://gateway.test/admin/usage'))
  assert.equal(unauthorized.status, 401)
})

test('GET /admin/usage returns cross-account logs newest-first with snake_case fields', async () => {
  const store = seedWithUsage()
  const app = createGatewayApp(appOptions(store))

  const response = await app.fetch(
    new Request('https://gateway.test/admin/usage', {
      headers: { authorization: 'Bearer admin-secret' },
    })
  )
  const payload = (await response.json()) as {
    data: Array<{ id: string; account_id: string; error_code: string | null; sell_cost_micro_usd: number | null }>
  }
  assert.equal(response.status, 200)
  // Spans both accounts.
  const accounts = new Set(payload.data.map((row) => row.account_id))
  assert.ok(accounts.has('acct-a'))
  assert.ok(accounts.has('acct-b'))
  // Newest first.
  assert.equal(payload.data[0].id, 'log-a2')
  assert.equal(payload.data[0].error_code, 'account_rate_limited')
  // snake_case mapping present.
  assert.ok('sell_cost_micro_usd' in payload.data[0])
})

test('GET /admin/usage honors the limit query parameter', async () => {
  const store = seedWithUsage()
  const app = createGatewayApp(appOptions(store))

  const response = await app.fetch(
    new Request('https://gateway.test/admin/usage?limit=1', {
      headers: { authorization: 'Bearer admin-secret' },
    })
  )
  const payload = (await response.json()) as { data: unknown[] }
  assert.equal(response.status, 200)
  assert.equal(payload.data.length, 1)
})

test('POST /admin/provider-tokens/:id/status toggles channel status and audits the change', async () => {
  const masterKeys = { v1: new Uint8Array(32).fill(31) }
  const store = new InMemoryGatewayStore({
    baseUrl: 'https://api.mykey.example',
    accounts: [],
    channels: [
      {
        id: 'tok-1',
        label: 'official-openai',
        provider: 'openai',
        adapter: 'openai',
        models: ['gpt-4.1-mini'],
        status: 'active',
        priority: 1,
        weight: 10,
        latencyMs: 0,
        errorRate: 0,
        exhaustedUntil: null,
      },
    ],
  })
  store.providerTokens.push(
    await encryptProviderToken({
      id: 'tok-1',
      provider: 'openai',
      label: 'official-openai',
      adapter: 'openai',
      plaintext: 'sk-upstream',
      masterKeys,
      keyVersion: 'v1',
      now: '2026-05-20T00:00:00Z',
    })
  )
  const app = createGatewayApp(appOptions(store, masterKeys))

  // Disable.
  const disable = await app.fetch(
    new Request('https://gateway.test/admin/provider-tokens/tok-1/status', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    })
  )
  const disablePayload = (await disable.json()) as { id: string; status: string }
  assert.equal(disable.status, 200)
  assert.equal(disablePayload.status, 'disabled')
  assert.equal(store.channels[0].status, 'disabled')
  assert.equal(store.providerTokens[0].status, 'disabled')

  // Audit recorded.
  const audit = store.auditLog.find((row) => row.action === 'admin.provider_token.set_status')
  assert.ok(audit, 'set_status audit entry present')
  assert.equal(audit.targetId, 'tok-1')
  assert.equal(audit.metadata.status, 'disabled')

  // Re-enable.
  const enable = await app.fetch(
    new Request('https://gateway.test/admin/provider-tokens/tok-1/status', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    })
  )
  assert.equal(enable.status, 200)
  assert.equal(store.channels[0].status, 'active')
})

test('POST /admin/provider-tokens/:id/status rejects an invalid status', async () => {
  const store = new InMemoryGatewayStore({ baseUrl: 'https://api.mykey.example', accounts: [] })
  const app = createGatewayApp(appOptions(store))
  const response = await app.fetch(
    new Request('https://gateway.test/admin/provider-tokens/tok-1/status', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'banana' }),
    })
  )
  assert.equal(response.status, 400)
})
