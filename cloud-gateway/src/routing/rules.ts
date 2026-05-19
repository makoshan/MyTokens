import type { RoutingRule } from '../types.js'

export function createDefaultRoutingRule(input: {
  id: string
  requestedModel: string
  providerTokenId: string
  actualProviderModel?: string
  accountGroup?: string
}): RoutingRule {
  return {
    id: input.id,
    accountGroup: input.accountGroup ?? 'default',
    requestedModel: input.requestedModel,
    providerTokenId: input.providerTokenId,
    actualProviderModel: input.actualProviderModel ?? input.requestedModel,
    priority: 1,
    weight: 1,
    status: 'active',
  }
}
