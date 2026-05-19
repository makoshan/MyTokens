import assert from 'node:assert/strict'
import test from 'node:test'
import { hashApiKey, registerApiKey } from '../src/auth/api-keys.js'
import { createGatewayApp } from '../src/index.js'
import { InMemoryGatewayStore } from '../src/db/store.js'
import { hashDashboardToken } from '../src/routes/dashboard.js'
import { encryptProviderToken } from '../src/vault/provider-tokens.js'

function seedStore() {
  const pepper = 'test-pepper'
  const dashboardToken = 'dashboard-session-secret'
  const apiKey = 'sk-mykey_live_testsecret'
  const store = new InMemoryGatewayStore({
    baseUrl: 'https://api.mykey.example',
    accounts: [
      {
        id: 'acct-1',
        displayName: 'Production Alpha',
        status: 'active',
        accountGroup: 'friends',
        balanceMicroUsd: 20_000_000,
        reservedMicroUsd: 0,
        defaultProvider: 'openai',
        defaultModel: 'gpt-4.1-mini',
        createdAt: '2026-05-19T00:00:00Z',
        updatedAt: '2026-05-19T00:00:00Z',
      },
    ],
    apiKeys: [
      registerApiKey({
        id: 'key-1',
        accountId: 'acct-1',
        rawKey: apiKey,
        pepper,
        now: '2026-05-19T00:00:00Z',
        name: 'agent key',
      }),
    ],
    dashboardSessions: [
      {
        id: 'session-1',
        accountId: 'acct-1',
        sessionHash: hashDashboardToken(dashboardToken),
        status: 'active',
        expiresAt: '2026-05-20T00:00:00Z',
      },
    ],
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
        latencyMs: 800,
        errorRate: 0.01,
        exhaustedUntil: null,
      },
    ],
    routingRules: [
      {
        id: 'route-1',
        accountGroup: 'friends',
        requestedModel: 'gpt-4.1-mini',
        providerTokenId: 'tok-1',
        actualProviderModel: 'gpt-4.1-mini',
        priority: 1,
        weight: 10,
        status: 'active',
      },
    ],
    usage: [
      {
        id: 'req-1',
        accountId: 'acct-1',
        createdAt: '2026-05-19T00:00:00Z',
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
    ],
    modelQuality: [
      {
        model: 'gpt-4.1-mini',
        label: 'trusted',
        latencyMs: 800,
        tokensPerSecond: 40,
        recentErrorRate: 0.01,
        channelStatus: 'active',
      },
    ],
  })

  return { store, pepper, dashboardToken, apiKey }
}

test('dashboard routes require a real dashboard session and never fall back to demo data', async () => {
  const { store, pepper, dashboardToken } = seedStore()
  const app = createGatewayApp({
    store,
    pepper,
    adminToken: 'admin-secret',
    now: () => '2026-05-19T00:00:00Z',
  })

  const unauthorized = await app.fetch(new Request('https://gateway.test/dashboard/me'))
  assert.equal(unauthorized.status, 401)

  const authorized = await app.fetch(
    new Request('https://gateway.test/dashboard/me', {
      headers: { cookie: `mykey_dashboard_session=${dashboardToken}` },
    })
  )
  const payload = await authorized.json()

  assert.equal(authorized.status, 200)
  assert.equal(payload.account.displayName, 'Production Alpha')
  assert.equal(payload.account.id, 'acct-1')
  assert.equal(payload.apiKeys[0].last4, 'cret')
  assert.equal(payload.apiKeys[0].keyHash, undefined)
  assert.equal(payload.channels[0].label, 'official-openai')
})

test('buyer API routes use MyKey API key auth and expose account-scoped balance', async () => {
  const { store, pepper, apiKey } = seedStore()
  const app = createGatewayApp({
    store,
    pepper,
    adminToken: 'admin-secret',
    now: () => '2026-05-19T00:00:00Z',
  })

  const missing = await app.fetch(new Request('https://gateway.test/v1/balance'))
  assert.equal(missing.status, 401)

  const response = await app.fetch(
    new Request('https://gateway.test/v1/balance', {
      headers: { authorization: `Bearer ${apiKey}` },
    })
  )
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.equal(payload.account_id, 'acct-1')
  assert.equal(payload.balance_micro_usd, 20_000_000)
  assert.equal(hashApiKey(apiKey, pepper), store.apiKeys[0].keyHash)
})

test('admin manual credit requires admin auth and updates the account snapshot', async () => {
  const { store, pepper } = seedStore()
  const app = createGatewayApp({
    store,
    pepper,
    adminToken: 'admin-secret',
    now: () => '2026-05-19T00:00:00Z',
  })

  const rejected = await app.fetch(
    new Request('https://gateway.test/admin/accounts/acct-1/manual-credit', {
      method: 'POST',
      body: JSON.stringify({ amount_micro_usd: 5_000_000 }),
    })
  )
  assert.equal(rejected.status, 401)

  const accepted = await app.fetch(
    new Request('https://gateway.test/admin/accounts/acct-1/manual-credit', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ amount_micro_usd: 5_000_000 }),
    })
  )
  const payload = await accepted.json()

  assert.equal(accepted.status, 200)
  assert.equal(payload.balance_micro_usd, 25_000_000)
})

test('admin account provisioning creates a one-time API key that can spend credited balance', async () => {
  const { store, pepper } = seedStore()
  const app = createGatewayApp({
    store,
    pepper,
    adminToken: 'admin-secret',
    now: () => '2026-05-19T00:00:00Z',
  })

  const accountResponse = await app.fetch(
    new Request('https://gateway.test/admin/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'acct-2',
        display_name: 'Friend Agent',
        account_group: 'friends',
        default_provider: 'openai',
        default_model: 'gpt-4.1-mini',
      }),
    })
  )
  assert.equal(accountResponse.status, 201)

  const keyResponse = await app.fetch(
    new Request('https://gateway.test/admin/accounts/acct-2/api-keys', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'friend default key' }),
    })
  )
  const keyPayload = await keyResponse.json()
  assert.equal(keyResponse.status, 201)
  assert.match(keyPayload.raw_key, /^sk-mykey_live_/)
  assert.equal(keyPayload.key_hash, undefined)

  await app.fetch(
    new Request('https://gateway.test/admin/accounts/acct-2/manual-credit', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ amount_micro_usd: 1_000_000 }),
    })
  )

  const balanceResponse = await app.fetch(
    new Request('https://gateway.test/v1/balance', {
      headers: { authorization: `Bearer ${keyPayload.raw_key}` },
    })
  )
  const balancePayload = await balanceResponse.json()
  assert.equal(balanceResponse.status, 200)
  assert.equal(balancePayload.account_id, 'acct-2')
  assert.equal(balancePayload.balance_micro_usd, 1_000_000)

  const accountsResponse = await app.fetch(
    new Request('https://gateway.test/admin/accounts', {
      headers: { authorization: 'Bearer admin-secret' },
    })
  )
  const accountsPayload = await accountsResponse.json()
  assert.ok(accountsPayload.data.some((account: { id: string }) => account.id === 'acct-2'))
})

test('POST /v1/responses decrypts provider token, relays upstream, settles usage, and logs request', async () => {
  const { store, pepper, apiKey } = seedStore()
  const masterKeys = { v1: new Uint8Array(32).fill(4) }
  store.providerTokens.push(
    await encryptProviderToken({
      id: 'tok-1',
      provider: 'openai',
      label: 'official-openai',
      adapter: 'openai',
      plaintext: 'sk-upstream-secret',
      masterKeys,
      keyVersion: 'v1',
      now: '2026-05-19T00:00:00Z',
    })
  )
  store.priceBook.push({
    id: 'price-1',
    version: 1,
    provider: 'openai',
    model: 'gpt-4.1-mini',
    sellInputMicroUsdPer1MTokens: 100_000,
    sellOutputMicroUsdPer1MTokens: 200_000,
    upstreamInputMicroUsdPer1MTokens: 50_000,
    upstreamOutputMicroUsdPer1MTokens: 100_000,
    validFrom: '2026-05-01T00:00:00Z',
    validTo: null,
    enabled: true,
  })

  const app = createGatewayApp({
    store,
    pepper,
    adminToken: 'admin-secret',
    masterKeys,
    now: () => '2026-05-19T00:00:00Z',
    fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer sk-upstream-secret')
      return Response.json({
        id: 'resp-production',
        model: 'gpt-4.1-mini',
        usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 },
      })
    },
  })

  const response = await app.fetch(
    new Request('https://gateway.test/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4.1-mini', input: 'hello', max_output_tokens: 20 }),
    })
  )
  const payload = await response.json()
  const account = await store.getAccount('acct-1')
  const lastLog = store.usage.at(-1)

  assert.equal(response.status, 200)
  assert.equal(payload.id, 'resp-production')
  assert.equal(account?.balanceMicroUsd, 19_999_950)
  assert.equal(lastLog?.endpoint, '/v1/responses')
  assert.equal(lastLog?.providerTokenId, 'tok-1')
  assert.equal(lastLog?.routingRuleId, 'route-1')
  assert.equal(lastLog?.sellCostMicroUsd, 50)
})

test('POST /v1/responses with stream:true forwards SSE upstream and settles via ctx.waitUntil after the stream completes', async () => {
  const { store, pepper, apiKey } = seedStore()
  const masterKeys = { v1: new Uint8Array(32).fill(9) }
  store.providerTokens.push(
    await encryptProviderToken({
      id: 'tok-1',
      provider: 'openai',
      label: 'official-openai',
      adapter: 'openai',
      plaintext: 'sk-upstream-secret',
      masterKeys,
      keyVersion: 'v1',
      now: '2026-05-19T00:00:00Z',
    })
  )
  store.priceBook.push({
    id: 'price-1',
    version: 1,
    provider: 'openai',
    model: 'gpt-4.1-mini',
    sellInputMicroUsdPer1MTokens: 100_000,
    sellOutputMicroUsdPer1MTokens: 200_000,
    upstreamInputMicroUsdPer1MTokens: 50_000,
    upstreamOutputMicroUsdPer1MTokens: 100_000,
    validFrom: '2026-05-01T00:00:00Z',
    validTo: null,
    enabled: true,
  })

  const upstreamChunks = [
    'event: response.created\n',
    'data: {"type":"response.created","response":{"id":"resp-stream"}}\n\n',
    'event: response.completed\n',
    'data: {"type":"response.completed","response":{"id":"resp-stream","usage":{"input_tokens":100,"output_tokens":200,"total_tokens":300}}}\n\n',
  ]

  const app = createGatewayApp({
    store,
    pepper,
    adminToken: 'admin-secret',
    masterKeys,
    now: () => '2026-05-19T00:00:00Z',
    fetchImpl: async () => {
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of upstreamChunks) {
            controller.enqueue(encoder.encode(chunk))
          }
          controller.close()
        },
      })
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })

  const waitPromises: Promise<unknown>[] = []
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      waitPromises.push(promise)
    },
  }

  const response = await app.fetch(
    new Request('https://gateway.test/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        input: 'hello',
        max_output_tokens: 20,
        stream: true,
      }),
    }),
    undefined,
    ctx
  )

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')

  const decoder = new TextDecoder()
  const reader = response.body!.getReader()
  let downstream = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    downstream += decoder.decode(value, { stream: true })
  }
  downstream += decoder.decode()
  assert.equal(downstream, upstreamChunks.join(''))

  assert.equal(waitPromises.length, 1)
  await Promise.all(waitPromises)

  const account = await store.getAccount('acct-1')
  const lastLog = store.usage.at(-1)
  assert.equal(account?.balanceMicroUsd, 19_999_950)
  assert.equal(lastLog?.endpoint, '/v1/responses')
  assert.equal(lastLog?.sellCostMicroUsd, 50)
  assert.equal(lastLog?.providerTokenId, 'tok-1')
  assert.equal(lastLog?.routingRuleId, 'route-1')
})

test('admin config endpoints create encrypted channels, price rows, and routing rules without exposing plaintext', async () => {
  const { store, pepper, apiKey } = seedStore()
  const masterKeys = { v1: new Uint8Array(32).fill(7) }
  const app = createGatewayApp({
    store,
    pepper,
    adminToken: 'admin-secret',
    masterKeys,
    now: () => '2026-05-19T00:00:00Z',
  })

  const rejected = await app.fetch(
    new Request('https://gateway.test/admin/provider-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'tok-admin',
        provider: 'openai',
        label: 'admin-openai',
        adapter: 'openai',
        plaintext: 'sk-admin-secret',
        models: ['gpt-4.1-nano'],
      }),
    })
  )
  assert.equal(rejected.status, 401)

  const tokenResponse = await app.fetch(
    new Request('https://gateway.test/admin/provider-tokens', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'tok-admin',
        provider: 'openai',
        label: 'admin-openai',
        adapter: 'openai',
        plaintext: 'sk-admin-secret',
        models: ['gpt-4.1-nano'],
      }),
    })
  )
  const tokenPayload = await tokenResponse.json()
  const storedToken = await store.getProviderToken('tok-admin')
  assert.equal(tokenResponse.status, 201)
  assert.equal(tokenPayload.id, 'tok-admin')
  assert.equal(tokenPayload.plaintext, undefined)
  assert.equal(tokenPayload.ciphertext, undefined)
  assert.notEqual(storedToken?.ciphertext, 'sk-admin-secret')

  const priceResponse = await app.fetch(
    new Request('https://gateway.test/admin/price-book', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'price-admin',
        provider: 'openai',
        model: 'gpt-4.1-nano',
        version: 1,
        sell_input_micro_usd_per_1m_tokens: 10_000,
        sell_output_micro_usd_per_1m_tokens: 20_000,
        upstream_input_micro_usd_per_1m_tokens: 5_000,
        upstream_output_micro_usd_per_1m_tokens: 10_000,
      }),
    })
  )
  assert.equal(priceResponse.status, 201)

  const routeResponse = await app.fetch(
    new Request('https://gateway.test/admin/routing-rules', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'route-admin',
        account_group: 'friends',
        requested_model: 'gpt-4.1-nano',
        provider_token_id: 'tok-admin',
        actual_provider_model: 'gpt-4.1-nano',
        priority: 1,
        weight: 10,
      }),
    })
  )
  assert.equal(routeResponse.status, 201)

  const modelsResponse = await app.fetch(
    new Request('https://gateway.test/v1/models', {
      headers: { authorization: `Bearer ${apiKey}` },
    })
  )
  const modelsPayload = await modelsResponse.json()
  assert.equal(modelsResponse.status, 200)
  assert.ok(modelsPayload.data.some((model: { id: string }) => model.id === 'gpt-4.1-nano'))
})
