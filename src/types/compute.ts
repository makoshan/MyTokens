export type ComputeAccountStatus = 'active' | 'paused' | 'disabled'

export interface ComputeAccount {
  id: string
  displayName: string
  status: ComputeAccountStatus
  accountGroup: string
  balanceMicroUsd: number
  reservedMicroUsd: number
  apiKeyCount: number
  dailyBudgetMicroUsd?: number
  createdAt: string
  updatedAt: string
}

export interface ComputeAccountSummary extends ComputeAccount {
  availableMicroUsd: number
  balanceLabel: string
  availableLabel: string
  operatorStatus: string
}

export interface ComputeGatewaySettings {
  publicGatewayUrl: string
  adminEndpoint: string
  adminKeyFingerprint?: string
  walletAddress?: string
}

export interface ComputeProviderToken {
  id: string
  provider: string
  label: string
  adapter: string
  status: 'active' | 'disabled' | 'revoked'
  lastUsedAt?: string
  exhaustedUntil?: string
  lastError?: string
}

export interface ComputeRoutingRule {
  id: string
  accountGroup: string
  requestedModel: string
  providerTokenId: string
  actualProviderModel: string
  priority: number
  weight: number
  status: 'active' | 'disabled'
}
