import type { ComputeAccount, ComputeAccountSummary } from '../types/compute'

export function formatComputeMicroUsd(value: number): string {
  const usd = value / 1_000_000
  if (value > 0 && value < 10_000) {
    return `$${usd.toFixed(6)}`
  }
  return `$${usd.toFixed(2)}`
}

export function buildComputeAdminHeaders(adminKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${adminKey}`,
    'content-type': 'application/json',
  }
}

export function normalizeComputeAccountSummary(account: ComputeAccount): ComputeAccountSummary {
  const availableMicroUsd = Math.max(0, account.balanceMicroUsd - account.reservedMicroUsd)
  return {
    ...account,
    availableMicroUsd,
    balanceLabel: formatComputeMicroUsd(account.balanceMicroUsd),
    availableLabel: formatComputeMicroUsd(availableMicroUsd),
    operatorStatus: `${account.status} / ${account.accountGroup}`,
  }
}
