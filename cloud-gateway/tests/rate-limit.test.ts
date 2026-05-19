import assert from 'node:assert/strict'
import test from 'node:test'
import { hashApiKey, registerApiKey } from '../src/auth/api-keys.js'
import { AccountBalance, RATE_LIMIT_WINDOW_MS } from '../src/billing/account-do.js'
import { AccountDurableObject } from '../src/billing/account-do-class.js'
import type { DurableObjectState } from '../src/billing/cloudflare-types.js'
import { InMemoryGatewayStore } from '../src/db/store.js'
import { createGatewayApp } from '../src/index.js'
import { hashDashboardToken } from '../src/routes/dashboard.js'
import { encryptProviderToken } from '../src/vault/provider-tokens.js'

test('AccountBalance.reserve throws account_rate_limited after the configured count in one window', () => {
  const balance = new AccountBalance({ accountId: 'acct-r1', balanceMicroUsd: 1_000_000, rpmLimit: 3 })

  const baseAt = '2026-05-20T12:00:00.000Z'
  for (let i = 0; i < 3; i += 1) {
    balance.reserve({
      reservationId: `res-${i}`,
      requestId: `req-${i}`,
      estimatedMicroUsd: 100,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      now: baseAt,
    })
  }

  assert.throws(
    () =>
      balance.reserve({
        reservationId: 'res-overflow',
        requestId: 'req-overflow',
        estimatedMicroUsd: 100,
        provider: 'openai',
        model: 'gpt-4.1-mini',
        now: baseAt,
      }),
    (error: unknown) => {
      assert.ok(error && typeof error === 'object' && 'code' in error)
      const typed = error as { code: string; status: number }
      assert.equal(typed.code, 'account_rate_limited')
      assert.equal(typed.status, 429)
      return true
    }
  )
})

test('rate-limit window resets after RATE_LIMIT_WINDOW_MS elapses', () => {
  const balance = new AccountBalance({ accountId: 'acct-r2', balanceMicroUsd: 1_000_000, rpmLimit: 2 })
  const start = Date.parse('2026-05-20T12:00:00.000Z')

  for (let i = 0; i < 2; i += 1) {
    balance.reserve({
      reservationId: `res-${i}`,
      requestId: `req-${i}`,
      estimatedMicroUsd: 100,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      now: new Date(start).toISOString(),
    })
  }

  // Same window: third call must reject.
  assert.throws(() =>
    balance.reserve({
      reservationId: 'res-3',
      requestId: 'req-3',
      estimatedMicroUsd: 100,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      now: new Date(start + RATE_LIMIT_WINDOW_MS - 1).toISOString(),
    })
  )

  // Window boundary: next call lands cleanly.
  balance.reserve({
    reservationId: 'res-4',
    requestId: 'req-4',
    estimatedMicroUsd: 100,
    provider: 'openai',
    model: 'gpt-4.1-mini',
    now: new Date(start + RATE_LIMIT_WINDOW_MS).toISOString(),
  })
})

test('rate-limit counter survives DO hibernation through toState/fromState', () => {
  const live = new AccountBalance({ accountId: 'acct-r3', balanceMicroUsd: 1_000_000, rpmLimit: 2 })
  const at = '2026-05-20T12:00:00.000Z'
  live.reserve({
    reservationId: 'res-1',
    requestId: 'req-1',
    estimatedMicroUsd: 100,
    provider: 'openai',
    model: 'gpt-4.1-mini',
    now: at,
  })

  const restored = AccountBalance.fromState(live.toState())
  restored.setRpmLimit(2)

  // Should still allow exactly one more in this window.
  restored.reserve({
    reservationId: 'res-2',
    requestId: 'req-2',
    estimatedMicroUsd: 100,
    provider: 'openai',
    model: 'gpt-4.1-mini',
    now: at,
  })
  assert.throws(() =>
    restored.reserve({
      reservationId: 'res-3',
      requestId: 'req-3',
      estimatedMicroUsd: 100,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      now: at,
    })
  )
})

test('Durable Object respects rpmLimit pushed via bootstrap and returns rate-limit envelope', async () => {
  const storage = new Map<string, unknown>()
  const state: DurableObjectState = {
    id: { toString: () => 'fake' },
    storage: {
      async get<T>(key: string): Promise<T | undefined> {
        return storage.get(key) as T | undefined
      },
      async put<T>(key: string, value: T): Promise<void> {
        storage.set(key, JSON.parse(JSON.stringify(value)))
      },
      async delete(key: string): Promise<boolean> {
        return storage.delete(key)
      },
    },
    blockConcurrencyWhile: async (cb) => cb(),
  }
  const durable = new AccountDurableObject(state, {})

  async function reserveOnce(reservationId: string) {
    const response = await durable.fetch(
      new Request('https://account-do/reserve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          accountId: 'acct-do-r',
          bootstrap: { balanceMicroUsd: 1_000_000, rpmLimit: 2 },
          reservationId,
          requestId: reservationId,
          estimatedMicroUsd: 100,
          provider: 'openai',
          model: 'gpt-4.1-mini',
          now: '2026-05-20T12:00:00.000Z',
        }),
      })
    )
    return (await response.json()) as { ok: boolean; code?: string; status?: number }
  }

  assert.equal((await reserveOnce('res-1')).ok, true)
  assert.equal((await reserveOnce('res-2')).ok, true)
  const third = await reserveOnce('res-3')
  assert.equal(third.ok, false)
  assert.equal(third.code, 'account_rate_limited')
  assert.equal(third.status, 429)
})

test('POST /v1/responses returns 429 rate_limit_error after exceeding accountRpmLimit', async () => {
  const pepper = 'rl-pepper'
  const apiKey = 'sk-mykey_live_ratelimittest'
  const masterKeys = { v1: new Uint8Array(32).fill(21) }
  const store = new InMemoryGatewayStore({
    baseUrl: 'https://api.mykey.example',
    accounts: [
      {
        id: 'acct-rl',
        displayName: 'Rate Limit Test',
        status: 'active',
        accountGroup: 'friends',
        balanceMicroUsd: 5_000_000,
        reservedMicroUsd: 0,
        defaultProvider: 'openai',
        defaultModel: 'gpt-4.1-mini',
        createdAt: '2026-05-20T00:00:00Z',
        updatedAt: '2026-05-20T00:00:00Z',
      },
    ],
    apiKeys: [
      registerApiKey({
        id: 'key-rl',
        accountId: 'acct-rl',
        rawKey: apiKey,
        pepper,
        now: '2026-05-20T00:00:00Z',
      }),
    ],
    dashboardSessions: [
      {
        id: 'sess-rl',
        accountId: 'acct-rl',
        sessionHash: hashDashboardToken('unused'),
        status: 'active',
        expiresAt: '2026-05-21T00:00:00Z',
      },
    ],
    channels: [
      {
        id: 'tok-rl',
        label: 'rl-openai',
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
    routingRules: [
      {
        id: 'route-rl',
        accountGroup: 'friends',
        requestedModel: 'gpt-4.1-mini',
        providerTokenId: 'tok-rl',
        actualProviderModel: 'gpt-4.1-mini',
        priority: 1,
        weight: 10,
        status: 'active',
      },
    ],
  })
  store.providerTokens.push(
    await encryptProviderToken({
      id: 'tok-rl',
      provider: 'openai',
      label: 'rl-openai',
      adapter: 'openai',
      plaintext: 'sk-upstream',
      masterKeys,
      keyVersion: 'v1',
      now: '2026-05-20T00:00:00Z',
    })
  )
  store.priceBook.push({
    id: 'price-rl',
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

  // Hash matches verifyApiKey expectations.
  const keyHash = hashApiKey(apiKey, pepper)
  assert.equal(store.apiKeys[0].keyHash, keyHash)

  let upstreamCalls = 0
  // Persistent counter across requests requires the DO path. We fake the
  // Cloudflare DurableObjectNamespace with one DO instance per accountId
  // sharing a single FakeStorage so the rate-limit window survives between
  // fetch calls — the same property the production binding gives us.
  const storages = new Map<string, Map<string, unknown>>()
  const dos = new Map<string, AccountDurableObject>()
  function durableNamespaceFake() {
    return {
      idFromName(name: string) {
        return { toString: () => name }
      },
      get(id: { toString(): string }) {
        const accountId = id.toString()
        let instance = dos.get(accountId)
        if (!instance) {
          const storage = storages.get(accountId) ?? new Map<string, unknown>()
          storages.set(accountId, storage)
          const state: DurableObjectState = {
            id: { toString: () => accountId },
            storage: {
              async get<T>(key: string): Promise<T | undefined> {
                return storage.get(key) as T | undefined
              },
              async put<T>(key: string, value: T): Promise<void> {
                storage.set(key, JSON.parse(JSON.stringify(value)))
              },
              async delete(key: string): Promise<boolean> {
                return storage.delete(key)
              },
            },
            blockConcurrencyWhile: async (cb) => cb(),
          }
          instance = new AccountDurableObject(state, {})
          dos.set(accountId, instance)
        }
        return {
          fetch(input: Request | string, init?: RequestInit): Promise<Response> {
            return instance!.fetch(input instanceof Request ? input : new Request(input, init))
          },
        }
      },
    }
  }

  const env = { ACCOUNT_DO: durableNamespaceFake() }
  const app = createGatewayApp({
    store,
    pepper,
    adminToken: 'admin',
    masterKeys,
    accountRpmLimit: 2,
    now: () => '2026-05-20T12:00:00.000Z',
    fetchImpl: async () => {
      upstreamCalls += 1
      return Response.json({
        id: 'resp-rl',
        model: 'gpt-4.1-mini',
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      })
    },
  })

  function makeCall(seed: string) {
    return app.fetch(
      new Request('https://gateway.test/v1/responses', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4.1-mini', input: seed, max_output_tokens: 10 }),
      }),
      env
    )
  }

  const first = await makeCall('hello-1')
  const second = await makeCall('hello-2')
  const third = await makeCall('hello-3')

  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(third.status, 429)
  const thirdBody = (await third.json()) as { error: { code: string; type: string } }
  assert.equal(thirdBody.error.code, 'account_rate_limited')
  assert.equal(thirdBody.error.type, 'rate_limit_error')
  assert.equal(upstreamCalls, 2, 'upstream must not be called once the limiter blocks the third request')
})
