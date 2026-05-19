export type AccountStatus = 'active' | 'paused' | 'disabled'
export type ApiKeyStatus = 'active' | 'revoked'
export type QualityLabel = 'trusted' | 'mostly reliable' | 'degraded' | 'suspicious'

export interface DashboardAccount {
  id: string
  displayName: string
  status: AccountStatus
}

export interface DashboardApiKey {
  id: string
  name: string
  prefix: string
  last4: string
  status: ApiKeyStatus
  createdAt: string
  quotaMicroUsd?: number
  usedMicroUsd?: number
}

export interface ChannelStatusRow {
  id: string
  label: string
  provider: string
  models: string[]
  status: 'active' | 'degraded' | 'exhausted' | 'paused'
  priority: number
  weight: number
  latencyMs: number
  errorRate: number
}

export interface RoutingRuleRow {
  id: string
  group: string
  requestedModel: string
  actualModel: string
  channelLabel: string
  status: 'active' | 'disabled'
}

export interface UsageRow {
  id: string
  createdAt: string
  model: string
  endpoint: string
  inputTokens: number
  outputTokens: number
  costMicroUsd: number
  latencyMs: number
  status: 'ok' | 'error' | 'blocked'
}

export interface ModelQualityRow {
  model: string
  label: QualityLabel
  latencyMs: number
  tokensPerSecond: number
  recentErrorRate: number
  channelStatus: 'active' | 'degraded' | 'exhausted' | 'paused'
}

export interface CreditRequestRow {
  id: string
  requestedMicroUsd: number
  message?: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt?: string
}

export interface DashboardSnapshot {
  account: DashboardAccount
  balanceMicroUsd: number
  todaySpendMicroUsd: number
  baseUrl: string
  apiKeys: DashboardApiKey[]
  channels: ChannelStatusRow[]
  routingRules: RoutingRuleRow[]
  usage: UsageRow[]
  modelQuality: ModelQualityRow[]
  creditRequests: CreditRequestRow[]
}
