import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryGatewayStore, type ChannelRecord, type GatewayAccountRecord } from '../src/db/store.js'
import type { RoutingRule, ProviderTokenSummary } from '../src/types.js'
import { resolveRoutingRule } from '../src/routing/router.js'

function account(id: string, operatorId: string, group: string, model = 'gpt'): GatewayAccountRecord {
  return {
    id,
    displayName: id,
    status: 'active',
    accountGroup: group,
    operatorId,
    balanceMicroUsd: 1_000_000,
    reservedMicroUsd: 0,
    defaultProvider: 'openai',
    defaultModel: model,
    createdAt: '2026-05-21T00:00:00Z',
    updatedAt: '2026-05-21T00:00:00Z',
  }
}
function channel(id: string, operatorId: string, models = ['gpt']): ChannelRecord {
  return {
    id,
    label: id,
    provider: 'openai',
    adapter: 'openai',
    operatorId,
    baseUrl: null,
    models,
    status: 'active',
    priority: 1,
    weight: 1,
    latencyMs: 0,
    errorRate: 0,
    exhaustedUntil: null,
  }
}
function rule(id: string, operatorId: string, group: string, tokenId: string, model = 'gpt'): RoutingRule {
  return {
    id,
    accountGroup: group,
    requestedModel: model,
    requestedProvider: 'openai',
    providerTokenId: tokenId,
    actualProviderModel: model,
    priority: 1,
    weight: 1,
    status: 'active',
    operatorId,
  }
}
// Same mapping handleRelayForAccount uses (providerTokenSummariesFromChannels).
function summaries(channels: ChannelRecord[]): ProviderTokenSummary[] {
  return channels.map((c) => ({
    id: c.id,
    provider: c.provider,
    adapter: c.adapter,
    baseUrl: c.baseUrl ?? null,
    status: c.status === 'active' ? 'active' : 'disabled',
    exhaustedUntil: c.exhaustedUntil,
  }))
}

function twoOperatorStore() {
  return new InMemoryGatewayStore({
    baseUrl: 'https://api.mykey.example',
    accounts: [account('acct-a', 'op_a', 'ga'), account('acct-b', 'op_b', 'gb')],
    channels: [channel('tok-a', 'op_a'), channel('tok-b', 'op_b')],
    routingRules: [rule('r-a', 'op_a', 'ga', 'tok-a'), rule('r-b', 'op_b', 'gb', 'tok-b')],
  })
}

test('store list methods scope by operatorId; unscoped returns all (legacy)', async () => {
  const store = twoOperatorStore()
  assert.deepEqual((await store.listProviderTokenSummaries('op_a')).map((c) => c.id), ['tok-a'])
  assert.deepEqual((await store.listProviderTokenSummaries('op_b')).map((c) => c.id), ['tok-b'])
  assert.equal((await store.listProviderTokenSummaries()).length, 2)
  assert.deepEqual((await store.listRoutingRules('op_a')).map((r) => r.id), ['r-a'])
  assert.deepEqual((await store.listRoutingRules('op_b')).map((r) => r.id), ['r-b'])
  assert.equal((await store.listRoutingRules()).length, 2)
})

test("relay routing for operator A's friend only ever resolves to A's token", async () => {
  const store = twoOperatorStore()
  const acct = (await store.getAccount('acct-a'))!
  const opId = acct.operatorId ?? undefined
  const routing = resolveRoutingRule({
    accountGroup: acct.accountGroup,
    requestedModel: 'gpt',
    requestedProvider: 'openai',
    rules: await store.listRoutingRules(opId),
    providerTokens: summaries(await store.listProviderTokenSummaries(opId)),
    now: '2026-05-21T00:00:00Z',
  })
  assert.equal(routing.providerToken.id, 'tok-a')
})

test("operator A's friend cannot reach B's token even when the route's group matches", async () => {
  // r-b is in group 'ga' (same as A's friend) but owned by op_b. Operator scoping
  // must still hide it from A — proving isolation isn't just group-based.
  const store = new InMemoryGatewayStore({
    baseUrl: 'https://api.mykey.example',
    accounts: [account('acct-a', 'op_a', 'ga', 'solo')],
    channels: [channel('tok-b', 'op_b', ['solo'])],
    routingRules: [rule('r-b', 'op_b', 'ga', 'tok-b', 'solo')],
  })
  const acct = (await store.getAccount('acct-a'))!
  const opId = acct.operatorId ?? undefined
  const rules = await store.listRoutingRules(opId) // empty: r-b is op_b
  const tokens = await store.listProviderTokenSummaries(opId) // empty
  assert.equal(rules.length, 0)
  assert.equal(tokens.length, 0)
  assert.throws(() =>
    resolveRoutingRule({
      accountGroup: acct.accountGroup,
      requestedModel: 'solo',
      requestedProvider: 'openai',
      rules,
      providerTokens: summaries(tokens),
      now: '2026-05-21T00:00:00Z',
    })
  )
})
