import type { DashboardApiKey, DashboardSnapshot, QualityLabel } from './types.js'

export type DashboardTab =
  | 'chat'
  | 'overview'
  | 'channels'
  | 'keys'
  | 'usage'
  | 'quality'
  | 'credits'
  | 'topup'
  | 'docs'

// Friends land in the web AI chat right after redeeming a red packet — they can
// test the shared model immediately, before deciding to mint an API key.
export function tabAfterRedpacketRedeem(): DashboardTab {
  return 'chat'
}

export const DEFAULT_DASHBOARD_TAB: DashboardTab = 'chat'

export function formatMicroUsd(value: number): string {
  const usd = value / 1_000_000
  if (value > 0 && value < 10_000) return `$${usd.toFixed(6)}`
  return `$${usd.toFixed(2)}`
}

export function maskApiKey(prefix: string, last4: string): string {
  return `${prefix}...${last4}`
}

function strongestQuality(labels: QualityLabel[]): QualityLabel {
  const order: QualityLabel[] = ['trusted', 'mostly reliable', 'degraded', 'suspicious']
  return labels.sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] ?? 'degraded'
}

export function buildDashboardViewModel(snapshot: DashboardSnapshot) {
  const visibleApiKeys = snapshot.apiKeys.map((apiKey: DashboardApiKey) => ({
    ...apiKey,
    displayKey: maskApiKey(apiKey.prefix, apiKey.last4),
  }))
  const totalTokensToday = snapshot.usage.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0)
  const lastRequest = snapshot.usage[0]
  const qualitySummary = strongestQuality(snapshot.modelQuality.map((row) => row.label))
  // Friend-facing MVP keeps only chat / API key / access. Operator-leaning views
  // (channels, logs, quality, credits…) move behind an "高级" toggle.
  const navigation: Array<{ id: DashboardTab; label: string; advanced?: boolean }> = [
    { id: 'chat', label: 'AI 对话' },
    { id: 'keys', label: 'MyKey API Key' },
    { id: 'docs', label: '接入说明' },
    { id: 'overview', label: '总览', advanced: true },
    { id: 'channels', label: '渠道', advanced: true },
    { id: 'usage', label: '日志', advanced: true },
    { id: 'quality', label: '模型检测', advanced: true },
    { id: 'credits', label: '额度', advanced: true },
    { id: 'topup', label: '充值', advanced: true },
  ]
  const channelSummary = {
    total: snapshot.channels.length,
    active: snapshot.channels.filter((channel) => channel.status === 'active').length,
    degraded: snapshot.channels.filter((channel) => channel.status !== 'active').length,
  }
  const tokenSummary = {
    total: snapshot.apiKeys.length,
    active: snapshot.apiKeys.filter((apiKey) => apiKey.status === 'active').length,
    revoked: snapshot.apiKeys.filter((apiKey) => apiKey.status === 'revoked').length,
  }
  const quickStartCurl = [
    'curl',
    `${snapshot.baseUrl}/v1/responses`,
    '-H "Authorization: Bearer sk-mykey_live_..."',
    '-H "Content-Type: application/json"',
    '-d \'{"model":"gpt-4.1-mini","input":"hello"}\'',
  ].join(' ')

  return {
    accountName: snapshot.account.displayName,
    accountStatus: snapshot.account.status,
    balanceLabel: formatMicroUsd(snapshot.balanceMicroUsd),
    todaySpendLabel: formatMicroUsd(snapshot.todaySpendMicroUsd),
    totalTokensToday,
    visibleApiKeys,
    lastRequest,
    qualitySummary,
    navigation,
    channelSummary,
    tokenSummary,
    quickStartCurl,
  }
}

export const localPreviewSnapshot: DashboardSnapshot = {
  account: { id: 'acct-preview', displayName: 'Friends Alpha', status: 'active' },
  balanceMicroUsd: 25_000_000,
  todaySpendMicroUsd: 42_500,
  baseUrl: 'https://api.mykey.example',
  apiKeys: [
    {
      id: 'key-preview',
      name: 'agent wallet',
      prefix: 'sk-mykey_live',
      last4: '8QxA',
      status: 'active',
      createdAt: '2026-05-19T00:00:00Z',
      quotaMicroUsd: 25_000_000,
      usedMicroUsd: 42_500,
    },
  ],
  channels: [
    {
      id: 'channel-openai',
      label: 'official-openai',
      provider: 'openai',
      models: ['gpt-4.1-mini', 'gpt-4.1'],
      status: 'active',
      priority: 1,
      weight: 10,
      latencyMs: 870,
      errorRate: 0.01,
    },
  ],
  routingRules: [
    {
      id: 'route-default-mini',
      group: 'friends',
      requestedModel: 'gpt-4.1-mini',
      actualModel: 'gpt-4.1-mini',
      channelLabel: 'official-openai',
      status: 'active',
    },
  ],
  usage: [
    {
      id: 'req_001',
      createdAt: '2026-05-19T08:12:00Z',
      model: 'gpt-4.1-mini',
      endpoint: '/v1/responses',
      inputTokens: 220,
      outputTokens: 380,
      costMicroUsd: 98,
      latencyMs: 870,
      status: 'ok',
    },
  ],
  modelQuality: [
    {
      model: 'gpt-4.1-mini',
      label: 'trusted',
      latencyMs: 870,
      tokensPerSecond: 37,
      recentErrorRate: 0.01,
      channelStatus: 'active',
    },
  ],
  creditRequests: [],
}
