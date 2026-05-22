export type QuotaStatus = 'healthy' | 'warning' | 'critical' | 'depleted'

export function getQuotaStatus(percentRemaining: number): QuotaStatus {
  if (percentRemaining <= 0) return 'depleted'
  if (percentRemaining < 20) return 'critical'
  if (percentRemaining < 50) return 'warning'
  return 'healthy'
}
