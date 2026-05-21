import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildDashboardViewModel,
  formatMicroUsd,
  maskApiKey,
} from '../src/dashboardViewModel.js'
import type { DashboardSnapshot } from '../src/types.js'

test('dashboard view model exposes balance, usage, model quality, and docs base URL', () => {
  const snapshot: DashboardSnapshot = {
    account: { id: 'acct-1', displayName: 'Alice Agent', status: 'active' },
    balanceMicroUsd: 12_345_678,
    todaySpendMicroUsd: 1_234,
    baseUrl: 'https://api.mykey.example',
    apiKeys: [
      {
        id: 'key-1',
        name: 'local agent',
        prefix: 'sk-mykey_live',
        last4: 'ABCD',
        status: 'active',
        createdAt: '2026-05-19T00:00:00Z',
        quotaMicroUsd: 10_000_000,
        usedMicroUsd: 1_000_000,
      },
    ],
    channels: [
      {
        id: 'channel-1',
        label: 'official-openai',
        provider: 'openai',
        models: ['gpt-4.1-mini'],
        status: 'active',
        priority: 1,
        weight: 10,
        latencyMs: 900,
        errorRate: 0.01,
      },
    ],
    routingRules: [
      {
        id: 'route-1',
        group: 'friends',
        requestedModel: 'gpt-4.1-mini',
        actualModel: 'gpt-4.1-mini',
        channelLabel: 'official-openai',
        status: 'active',
      },
    ],
    usage: [
      {
        id: 'req-1',
        createdAt: '2026-05-19T00:01:00Z',
        model: 'gpt-4.1-mini',
        endpoint: '/v1/responses',
        inputTokens: 100,
        outputTokens: 200,
        costMicroUsd: 50,
        latencyMs: 900,
        status: 'ok',
      },
    ],
    modelQuality: [
      {
        model: 'gpt-4.1-mini',
        label: 'trusted',
        latencyMs: 900,
        tokensPerSecond: 35,
        recentErrorRate: 0.01,
        channelStatus: 'active',
      },
    ],
    creditRequests: [],
  }

  const viewModel = buildDashboardViewModel(snapshot)

  assert.equal(viewModel.balanceLabel, '$12.35')
  assert.equal(viewModel.todaySpendLabel, '$0.001234')
  assert.equal(viewModel.visibleApiKeys[0].displayKey, 'sk-mykey_live...ABCD')
  assert.equal(viewModel.qualitySummary, 'trusted')
  assert.equal(viewModel.quickStartCurl.includes('https://api.mykey.example/v1/responses'), true)
  assert.deepEqual(
    viewModel.navigation.map((item) => item.label),
    ['总览', '渠道', '令牌', '日志', '模型检测', '额度', '充值', '文档']
  )
  assert.equal(viewModel.channelSummary.active, 1)
  assert.equal(viewModel.tokenSummary.active, 1)
})

test('formatting helpers avoid leaking full keys and keep micro USD precision', () => {
  assert.equal(formatMicroUsd(1), '$0.000001')
  assert.equal(formatMicroUsd(1_000_000), '$1.00')
  assert.equal(maskApiKey('sk-mykey_test', 'WXYZ'), 'sk-mykey_test...WXYZ')
})
