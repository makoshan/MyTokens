import { GatewayError } from '../errors.js'
import type { ProviderTokenSummary, ResolvedRoute, RoutingRule } from '../types.js'

function isTokenHealthy(token: ProviderTokenSummary, now: string): boolean {
  if (token.status !== 'active') return false
  if (!token.exhaustedUntil) return true
  return Date.parse(token.exhaustedUntil) <= Date.parse(now)
}

export function resolveRoutingRule(input: {
  accountGroup: string
  requestedModel: string
  requestedProvider?: string
  rules: RoutingRule[]
  providerTokens: ProviderTokenSummary[]
  now: string
}): ResolvedRoute {
  const tokensById = new Map(input.providerTokens.map((token) => [token.id, token]))
  const candidates = input.rules
    .filter((rule) => {
      if (rule.status !== 'active') return false
      if (rule.accountGroup !== input.accountGroup && rule.accountGroup !== 'default') return false
      if (rule.requestedModel !== input.requestedModel) return false
      const token = tokensById.get(rule.providerTokenId)
      if (input.requestedProvider && rule.requestedProvider && token) {
        const matchesAdapter = rule.requestedProvider === input.requestedProvider
        const matchesUpstreamProvider = rule.requestedProvider === token.provider
        if (!matchesAdapter && !matchesUpstreamProvider) return false
      }
      return token ? isTokenHealthy(token, input.now) : false
    })
    .sort((a, b) => {
      if (a.accountGroup !== b.accountGroup) return a.accountGroup === input.accountGroup ? -1 : 1
      if (a.priority !== b.priority) return a.priority - b.priority
      return b.weight - a.weight
    })

  const routingRule = candidates[0]
  if (!routingRule) throw new GatewayError('no_healthy_route', 503)
  const providerToken = tokensById.get(routingRule.providerTokenId)
  if (!providerToken) throw new GatewayError('route_provider_token_missing', 500)

  return {
    routingRule,
    providerToken,
    actualProviderModel: routingRule.actualProviderModel || routingRule.requestedModel,
  }
}
