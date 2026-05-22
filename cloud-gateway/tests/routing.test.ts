import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveRoutingRule } from '../src/routing/router.js'

test('routing resolves account group and requested model to a healthy provider token', () => {
  const resolved = resolveRoutingRule({
    accountGroup: 'friends',
    requestedModel: 'gpt-4.1-mini',
    rules: [
      {
        id: 'rule-disabled',
        accountGroup: 'friends',
        requestedModel: 'gpt-4.1-mini',
        providerTokenId: 'tok-disabled',
        actualProviderModel: 'gpt-4.1-mini',
        priority: 10,
        weight: 1,
        status: 'disabled',
      },
      {
        id: 'rule-1',
        accountGroup: 'friends',
        requestedModel: 'gpt-4.1-mini',
        providerTokenId: 'tok-1',
        actualProviderModel: 'gpt-4.1-mini',
        priority: 1,
        weight: 1,
        status: 'active',
      },
    ],
    providerTokens: [
      { id: 'tok-1', provider: 'openai', adapter: 'openai', status: 'active', exhaustedUntil: null },
    ],
    now: '2026-05-19T00:00:00Z',
  })

  assert.equal(resolved.routingRule.id, 'rule-1')
  assert.equal(resolved.providerToken.id, 'tok-1')
  assert.equal(resolved.actualProviderModel, 'gpt-4.1-mini')
})

test('routing skips exhausted tokens and fails closed when no route is healthy', () => {
  assert.throws(
    () =>
      resolveRoutingRule({
        accountGroup: 'default',
        requestedModel: 'gpt-4.1-mini',
        rules: [
          {
            id: 'rule-1',
            accountGroup: 'default',
            requestedModel: 'gpt-4.1-mini',
            providerTokenId: 'tok-1',
            actualProviderModel: 'gpt-4.1-mini',
            priority: 1,
            weight: 1,
            status: 'active',
          },
        ],
        providerTokens: [
          {
            id: 'tok-1',
            provider: 'openai',
            adapter: 'openai',
            status: 'active',
            exhaustedUntil: '2026-05-19T01:00:00Z',
          },
        ],
        now: '2026-05-19T00:00:00Z',
      }),
    /no_healthy_route/
  )
})
