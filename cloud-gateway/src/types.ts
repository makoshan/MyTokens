export type KeyStatus = 'active' | 'revoked' | 'disabled'
export type AccountStatus = 'active' | 'paused' | 'disabled'
export type ProviderTokenStatus = 'active' | 'disabled' | 'revoked'
export type RoutingRuleStatus = 'active' | 'disabled'

export interface ApiKeyRecord {
  id: string
  accountId: string
  name?: string
  keyPrefix: string
  keyLast4: string
  keyHash: string
  scope: string
  derivationMode: 'random' | 'derived'
  derivationFingerprint?: string
  derivationIndex?: number
  ipAllowlistJson?: string
  modelAllowlistJson?: string
  rpmLimit?: number
  status: KeyStatus
  createdAt: string
  lastUsedAt?: string
  expiresAt?: string
  revokedAt?: string
}

export interface PriceBookRow {
  id: string
  version: number
  provider: string
  model: string
  sellInputMicroUsdPer1MTokens: number
  sellOutputMicroUsdPer1MTokens: number
  upstreamInputMicroUsdPer1MTokens: number
  upstreamOutputMicroUsdPer1MTokens: number
  validFrom: string
  validTo: string | null
  enabled: boolean
}

export interface ProviderTokenSummary {
  id: string
  provider: string
  adapter: string
  status: ProviderTokenStatus
  exhaustedUntil: string | null
  successCount?: number
  failureCount?: number
  lastError?: string
  lastResponseMs?: number
}

export interface RoutingRule {
  id: string
  accountGroup: string
  requestedModel: string
  requestedProvider?: string
  providerTokenId: string
  actualProviderModel: string
  priority: number
  weight: number
  status: RoutingRuleStatus
}

export interface ResolvedRoute {
  routingRule: RoutingRule
  providerToken: ProviderTokenSummary
  actualProviderModel: string
}

export type CreditRequestStatus = 'pending' | 'approved' | 'rejected'

export interface CreditRequestRecord {
  id: string
  accountId: string
  requestedMicroUsd: number
  message?: string
  status: CreditRequestStatus
  createdAt: string
  resolvedAt?: string | null
  resolvedBy?: string | null
}

export interface RequestLog {
  id: string
  accountId: string
  apiKeyId?: string
  providerTokenId?: string
  routingRuleId?: string
  createdAt: string
  provider: string
  model: string
  endpoint: string
  statusCode: number
  latencyMs: number
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  sellCostMicroUsd?: number
  upstreamCostMicroUsd?: number
  errorCode?: string
  requestHash?: string
}
