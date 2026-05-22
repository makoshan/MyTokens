import assert from 'node:assert/strict'
import test from 'node:test'
import { privateKeyToAccount } from 'viem/accounts'
import { createGatewayApp, type GatewayAppOptions } from '../src/index.js'
import { InMemoryGatewayStore } from '../src/db/store.js'
import { buildOperatorChallenge } from '../src/routes/operator-auth.js'

const NOW = '2026-05-21T00:00:00.000Z'
const OPERATOR_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const

type App = ReturnType<typeof createGatewayApp>

function appOptions(store: InMemoryGatewayStore): GatewayAppOptions {
  return {
    store,
    pepper: 'test-pepper',
    masterKeys: { v1: new Uint8Array(32).fill(7) },
    baseUrl: 'https://dashboard.mykey.example',
    now: () => NOW,
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      assert.equal(String(url), 'https://api.moonshot.cn/v1/responses')
      assert.equal(headers.get('authorization'), 'Bearer sk-kimi-upstream')
      return Response.json({
        id: 'resp_happy_path',
        model: 'moonshot-v1-8k',
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      })
    },
  }
}

async function registerOperator(app: App): Promise<string> {
  const account = privateKeyToAccount(OPERATOR_PK)
  const address = account.address.toLowerCase()
  const challenge = buildOperatorChallenge(address, NOW)
  const sig = await account.signMessage({ message: challenge })
  const res = await app.fetch(
    new Request('https://gateway.test/operator/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address, challenge, sig, display_name: 'Alice Operator' }),
    })
  )
  assert.equal(res.status, 201)
  return ((await res.json()) as { session_token: string }).session_token
}

async function operatorRequest(app: App, method: string, path: string, session: string, body?: unknown): Promise<Response> {
  return app.fetch(
    new Request(`https://gateway.test${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-operator-session': session },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  )
}

function dashboardSessionFromAccept(response: Response): string {
  const cookie = response.headers.get('set-cookie') ?? ''
  const match = /mykey_dashboard_session=([^;]+)/.exec(cookie)
  assert.ok(match, 'accept response should set a dashboard session cookie')
  return match[1]
}

test('operator can register, share an OpenAI-compatible token, invite and credit a friend, then the friend uses /v1/responses', async () => {
  const store = new InMemoryGatewayStore({ baseUrl: 'https://api.mykey.example', accounts: [] })
  const app = createGatewayApp(appOptions(store))
  const operatorSession = await registerOperator(app)

  const channel = await operatorRequest(app, 'POST', '/operator/provider-tokens', operatorSession, {
    provider: 'kimi',
    adapter: 'openai',
    base_url: 'https://api.moonshot.cn/v1',
    label: 'Kimi shared',
    plaintext: 'sk-kimi-upstream',
    models: ['moonshot-v1-8k'],
  })
  assert.equal(channel.status, 201)
  const { id: providerTokenId } = (await channel.json()) as { id: string }

  assert.equal(
    (
      await operatorRequest(app, 'POST', '/operator/price-book', operatorSession, {
        provider: 'kimi',
        model: 'moonshot-v1-8k',
        version: 1,
        sell_input_micro_usd_per_1m_tokens: 100_000,
        sell_output_micro_usd_per_1m_tokens: 200_000,
        upstream_input_micro_usd_per_1m_tokens: 50_000,
        upstream_output_micro_usd_per_1m_tokens: 100_000,
      })
    ).status,
    201
  )
  assert.equal(
    (
      await operatorRequest(app, 'POST', '/operator/routing-rules', operatorSession, {
        account_group: 'friends',
        requested_provider: 'kimi',
        requested_model: 'moonshot-v1-8k',
        provider_token_id: providerTokenId,
        actual_provider_model: 'moonshot-v1-8k',
        priority: 1,
        weight: 10,
      })
    ).status,
    201
  )

  const account = await operatorRequest(app, 'POST', '/operator/accounts', operatorSession, {
    display_name: 'Friend One',
    account_group: 'friends',
    default_provider: 'openai',
    default_model: 'moonshot-v1-8k',
  })
  assert.equal(account.status, 201)
  const { id: accountId } = (await account.json()) as { id: string }

  const invite = await operatorRequest(app, 'POST', `/operator/accounts/${accountId}/invites`, operatorSession, {})
  assert.equal(invite.status, 201)
  const { invite_token: inviteToken } = (await invite.json()) as { invite_token: string }

  const credit = await operatorRequest(app, 'POST', `/operator/accounts/${accountId}/manual-credit`, operatorSession, {
    amount_micro_usd: 1_000_000,
  })
  assert.equal(credit.status, 200)

  const accept = await app.fetch(
    new Request(`https://gateway.test/accept?token=${encodeURIComponent(inviteToken)}&tab=keys`)
  )
  assert.equal(accept.status, 302)
  // Fresh manual-credit join → welcome/claim overlay (passkey wallet + reveal), tab preserved.
  assert.equal(accept.headers.get('location'), '/?welcome=1&tab=keys')
  const dashboardSession = dashboardSessionFromAccept(accept)

  const apiKey = await app.fetch(
    new Request('https://gateway.test/dashboard/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dashboard-session': dashboardSession },
      body: JSON.stringify({ name: 'Friend CLI key' }),
    })
  )
  assert.equal(apiKey.status, 201)
  const { raw_key: rawKey } = (await apiKey.json()) as { raw_key: string }

  const response = await app.fetch(
    new Request('https://gateway.test/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${rawKey}` },
      body: JSON.stringify({ model: 'moonshot-v1-8k', input: 'hello', max_output_tokens: 10 }),
    })
  )
  assert.equal(response.status, 200)
  const payload = (await response.json()) as { id: string }
  assert.equal(payload.id, 'resp_happy_path')

  const balance = await app.fetch(
    new Request('https://gateway.test/v1/balance', {
      headers: { authorization: `Bearer ${rawKey}` },
    })
  )
  assert.equal(balance.status, 200)
  assert.equal(((await balance.json()) as { balance_micro_usd: number }).balance_micro_usd, 999_995)
})

// Two models share one channel/group. The friend is authorized for only one of
// them; the allowlist must gate both what the friend can *see* (/v1/models) and
// what they can *call* (relay 403), and the operator must be able to widen it.
function multiModelAppOptions(store: InMemoryGatewayStore): GatewayAppOptions {
  return {
    store,
    pepper: 'test-pepper',
    masterKeys: { v1: new Uint8Array(32).fill(7) },
    baseUrl: 'https://dashboard.mykey.example',
    now: () => NOW,
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      assert.equal(String(url), 'https://api.moonshot.cn/v1/responses')
      assert.equal(headers.get('authorization'), 'Bearer sk-kimi-upstream')
      const requested = JSON.parse(String(init?.body ?? '{}')) as { model?: string }
      return Response.json({
        id: 'resp_multi_model',
        model: requested.model ?? 'moonshot-v1-8k',
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      })
    },
  }
}

test('operator authorizes a friend for a subset of models; allowlist gates listing + relay, PATCH widens it, and invites can be listed and revoked', async () => {
  const store = new InMemoryGatewayStore({ baseUrl: 'https://api.mykey.example', accounts: [] })
  const app = createGatewayApp(multiModelAppOptions(store))
  const operatorSession = await registerOperator(app)

  const channel = await operatorRequest(app, 'POST', '/operator/provider-tokens', operatorSession, {
    provider: 'kimi',
    adapter: 'openai',
    base_url: 'https://api.moonshot.cn/v1',
    label: 'Kimi shared',
    plaintext: 'sk-kimi-upstream',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k'],
  })
  assert.equal(channel.status, 201)
  const { id: providerTokenId } = (await channel.json()) as { id: string }

  for (const model of ['moonshot-v1-8k', 'moonshot-v1-32k']) {
    assert.equal(
      (
        await operatorRequest(app, 'POST', '/operator/price-book', operatorSession, {
          provider: 'kimi',
          model,
          version: 1,
          sell_input_micro_usd_per_1m_tokens: 100_000,
          sell_output_micro_usd_per_1m_tokens: 200_000,
          upstream_input_micro_usd_per_1m_tokens: 50_000,
          upstream_output_micro_usd_per_1m_tokens: 100_000,
        })
      ).status,
      201
    )
    assert.equal(
      (
        await operatorRequest(app, 'POST', '/operator/routing-rules', operatorSession, {
          account_group: 'friends',
          requested_provider: 'kimi',
          requested_model: model,
          provider_token_id: providerTokenId,
          actual_provider_model: model,
          priority: 1,
          weight: 10,
        })
      ).status,
      201
    )
  }

  // Authorize the friend for only one of the two routed models.
  const account = await operatorRequest(app, 'POST', '/operator/accounts', operatorSession, {
    display_name: 'Friend One',
    account_group: 'friends',
    default_provider: 'openai',
    default_model: 'moonshot-v1-8k',
    model_allowlist: ['moonshot-v1-8k'],
  })
  assert.equal(account.status, 201)
  const created = (await account.json()) as { id: string; model_allowlist: string[] }
  assert.deepEqual(created.model_allowlist, ['moonshot-v1-8k'])
  const accountId = created.id

  const accountList = await operatorRequest(app, 'GET', '/operator/accounts', operatorSession)
  const listed = ((await accountList.json()) as { data: Array<{ id: string; model_allowlist: string[] }> }).data.find(
    (row) => row.id === accountId
  )
  assert.deepEqual(listed?.model_allowlist, ['moonshot-v1-8k'])

  const invite = await operatorRequest(app, 'POST', `/operator/accounts/${accountId}/invites`, operatorSession, {})
  assert.equal(invite.status, 201)
  const { invite_id: inviteId, invite_token: inviteToken } = (await invite.json()) as {
    invite_id: string
    invite_token: string
  }

  assert.equal(
    (
      await operatorRequest(app, 'POST', `/operator/accounts/${accountId}/manual-credit`, operatorSession, {
        amount_micro_usd: 1_000_000,
      })
    ).status,
    200
  )

  const accept = await app.fetch(
    new Request(`https://gateway.test/accept?token=${encodeURIComponent(inviteToken)}&tab=keys`)
  )
  const dashboardSession = dashboardSessionFromAccept(accept)
  const apiKey = await app.fetch(
    new Request('https://gateway.test/dashboard/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dashboard-session': dashboardSession },
      body: JSON.stringify({ name: 'Friend CLI key' }),
    })
  )
  assert.equal(apiKey.status, 201)
  const { raw_key: rawKey } = (await apiKey.json()) as { raw_key: string }

  // Visibility: the friend only sees the one model they're authorized for.
  const modelsBefore = await app.fetch(
    new Request('https://gateway.test/v1/models', { headers: { authorization: `Bearer ${rawKey}` } })
  )
  assert.deepEqual(
    ((await modelsBefore.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id),
    ['moonshot-v1-8k']
  )

  async function callModel(model: string): Promise<Response> {
    return app.fetch(
      new Request('https://gateway.test/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${rawKey}` },
        body: JSON.stringify({ model, input: 'hello', max_output_tokens: 10 }),
      })
    )
  }

  // Enforcement: the authorized model relays; the unauthorized one is blocked.
  assert.equal((await callModel('moonshot-v1-8k')).status, 200)
  const blocked = await callModel('moonshot-v1-32k')
  assert.equal(blocked.status, 403)
  assert.equal(((await blocked.json()) as { error: { code: string } }).error.code, 'model_not_allowed_for_account')

  // Operator widens the allowlist via PATCH; the friend can now use both.
  const patched = await operatorRequest(app, 'PATCH', `/operator/accounts/${accountId}`, operatorSession, {
    display_name: 'Friend One',
    default_model: 'moonshot-v1-8k',
    model_allowlist: ['moonshot-v1-8k', 'moonshot-v1-32k'],
  })
  assert.equal(patched.status, 200)
  assert.deepEqual(
    ((await patched.json()) as { model_allowlist: string[] }).model_allowlist.sort(),
    ['moonshot-v1-32k', 'moonshot-v1-8k']
  )

  const modelsAfter = await app.fetch(
    new Request('https://gateway.test/v1/models', { headers: { authorization: `Bearer ${rawKey}` } })
  )
  assert.deepEqual(
    ((await modelsAfter.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id).sort(),
    ['moonshot-v1-32k', 'moonshot-v1-8k']
  )
  assert.equal((await callModel('moonshot-v1-32k')).status, 200)

  // Invite management: the accepted invite is listed as 'accepted', carrying the
  // account's display name for the operator console table.
  const invitesList = await operatorRequest(app, 'GET', '/operator/invites', operatorSession)
  assert.equal(invitesList.status, 200)
  const inviteRow = (
    (await invitesList.json()) as { data: Array<{ id: string; status: string; account_display_name: string }> }
  ).data.find((row) => row.id === inviteId)
  assert.equal(inviteRow?.status, 'accepted')
  assert.equal(inviteRow?.account_display_name, 'Friend One')

  // A fresh, unused invite can be cancelled: active → revoked.
  const second = await operatorRequest(app, 'POST', `/operator/accounts/${accountId}/invites`, operatorSession, {})
  const { invite_id: secondInviteId } = (await second.json()) as { invite_id: string }

  const revoke = await operatorRequest(app, 'POST', `/operator/invites/${secondInviteId}/revoke`, operatorSession, {})
  assert.equal(revoke.status, 200)
  assert.equal(((await revoke.json()) as { status: string }).status, 'revoked')

  const invitesAfter = await operatorRequest(app, 'GET', '/operator/invites', operatorSession)
  const revokedRow = ((await invitesAfter.json()) as { data: Array<{ id: string; status: string }> }).data.find(
    (row) => row.id === secondInviteId
  )
  assert.equal(revokedRow?.status, 'revoked')
})
