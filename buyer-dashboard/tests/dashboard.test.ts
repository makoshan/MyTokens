import assert from 'node:assert/strict'
import test from 'node:test'
import { extractAssistantText } from '../src/api.js'
import { buildChatModelOptions, composeChatInput, friendlyError } from '../src/chatHelpers.js'
import {
  buildDashboardViewModel,
  formatMicroUsd,
  maskApiKey,
  tabAfterRedpacketRedeem,
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
  // Friend-facing primary nav leads with AI 对话 / MyKey API Key / 接入说明; the
  // operator-leaning views are marked advanced (hidden behind a toggle in the UI).
  assert.deepEqual(
    viewModel.navigation.map((item) => item.label),
    ['AI 对话', 'MyKey API Key', '接入说明', '总览', '渠道', '日志', '模型检测', '额度', '充值']
  )
  assert.deepEqual(
    viewModel.navigation.filter((item) => !item.advanced).map((item) => item.id),
    ['chat', 'keys', 'docs']
  )
  assert.equal(viewModel.channelSummary.active, 1)
  assert.equal(viewModel.tokenSummary.active, 1)
})

test('formatting helpers avoid leaking full keys and keep micro USD precision', () => {
  assert.equal(formatMicroUsd(1), '$0.000001')
  assert.equal(formatMicroUsd(1_000_000), '$1.00')
  assert.equal(maskApiKey('sk-mykey_test', 'WXYZ'), 'sk-mykey_test...WXYZ')
})

test('red packet completion lands buyers in the web AI chat to test immediately', () => {
  assert.equal(tabAfterRedpacketRedeem(), 'chat')
})

test('chat model options only expose active routed models', () => {
  const snapshot: DashboardSnapshot = {
    account: { id: 'acct-1', displayName: 'Alice Agent', status: 'active' },
    balanceMicroUsd: 10_000_000,
    todaySpendMicroUsd: 0,
    baseUrl: 'https://api.mykey.example',
    apiKeys: [],
    channels: [
      {
        id: 'channel-openai',
        label: 'official-openai',
        provider: 'openai',
        models: ['gpt-4.1-mini'],
        status: 'active',
        priority: 1,
        weight: 10,
        latencyMs: 900,
        errorRate: 0.01,
      },
      {
        id: 'channel-kimi',
        label: 'Kimi for Coding',
        provider: 'kimi',
        models: ['kimi-for-coding'],
        status: 'active',
        priority: 1,
        weight: 10,
        latencyMs: 900,
        errorRate: 0.01,
      },
    ],
    routingRules: [
      {
        id: 'route-openai',
        group: 'friends',
        requestedModel: 'gpt-4.1-mini',
        actualModel: 'gpt-4.1-mini',
        channelLabel: 'official-openai',
        status: 'active',
      },
      {
        id: 'route-kimi-disabled',
        group: 'friends',
        requestedModel: 'kimi-for-coding',
        actualModel: 'kimi-for-coding',
        channelLabel: 'Kimi for Coding',
        status: 'disabled',
      },
    ],
    usage: [],
    modelQuality: [],
    creditRequests: [],
  }

  assert.deepEqual(
    buildChatModelOptions(snapshot).map((option) => option.model),
    ['gpt-4.1-mini']
  )
})

test('chat helpers explain route failures and include selected capabilities in the prompt', () => {
  assert.equal(
    friendlyError('no_healthy_route'),
    '这个模型还没有给当前账户开通可用路由，请让运营者刷新或添加该模型路由。'
  )
  const payload = composeChatInput('测试使用', ['mcp', 'skills'])
  assert.equal(payload.includes('MCP 已开启'), true)
  assert.equal(payload.includes('Skills 已开启'), true)
  assert.equal(payload.endsWith('测试使用'), true)
})

test('extractAssistantText reads OpenAI Responses, Anthropic messages, and chat completion shapes', () => {
  // OpenAI Responses convenience field
  assert.equal(extractAssistantText({ output_text: 'hi there' }), 'hi there')
  // OpenAI Responses output array
  assert.equal(
    extractAssistantText({ output: [{ content: [{ type: 'output_text', text: 'from output' }] }] }),
    'from output'
  )
  // Anthropic messages content blocks
  assert.equal(
    extractAssistantText({ content: [{ type: 'text', text: 'anthropic reply' }] }),
    'anthropic reply'
  )
  // OpenAI chat completions
  assert.equal(
    extractAssistantText({ choices: [{ message: { content: 'chat reply' } }] }),
    'chat reply'
  )
  // Unknown shape → empty string (UI shows a placeholder)
  assert.equal(extractAssistantText({ weird: true }), '')
})
