import assert from 'node:assert/strict'
import test from 'node:test'
import { AccountBalance } from '../src/billing/account-do.js'
import { relayOpenAIResponses } from '../src/routes/openai.js'

test('OpenAI responses relay reserves before upstream and settles from returned usage', async () => {
  const account = new AccountBalance({ accountId: 'acct-1', balanceMicroUsd: 10_000 })
  const calls: Array<{ url: string; body: unknown; authorization: string | null }> = []

  const result = await relayOpenAIResponses({
    account,
    apiKeyId: 'key-1',
    requestId: 'req-1',
    body: { model: 'gpt-4.1-mini', input: 'hello', max_output_tokens: 10 },
    routing: {
      routingRule: {
        id: 'route-1',
        accountGroup: 'default',
        requestedModel: 'gpt-4.1-mini',
        providerTokenId: 'tok-1',
        actualProviderModel: 'gpt-4.1-mini',
        priority: 1,
        weight: 1,
        status: 'active',
      },
      providerToken: {
        id: 'tok-1',
        provider: 'openai',
        adapter: 'openai',
        status: 'active',
        exhaustedUntil: null,
      },
      actualProviderModel: 'gpt-4.1-mini',
    },
    upstreamApiKey: 'sk-upstream-secret',
    priceBook: [
      {
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
      },
    ],
    now: '2026-05-19T00:00:00Z',
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        authorization: new Headers(init?.headers).get('authorization'),
      })
      return new Response(
        JSON.stringify({
          id: 'resp-1',
          model: 'gpt-4.1-mini',
          usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    },
  })

  assert.equal(result.status, 200)
  assert.equal(result.log.sellCostMicroUsd, 50)
  assert.equal(account.snapshot().balanceMicroUsd, 9_950)
  assert.equal(calls[0].authorization, 'Bearer sk-upstream-secret')
  assert.deepEqual(calls[0].body, { model: 'gpt-4.1-mini', input: 'hello', max_output_tokens: 10 })
})
