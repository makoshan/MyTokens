import type { DashboardSnapshot } from './types.js'

export async function loadDashboardSnapshot(fetchImpl: typeof fetch = fetch): Promise<DashboardSnapshot> {
  const response = await fetchImpl('/dashboard/me', { credentials: 'include' })
  if (!response.ok) {
    throw new Error(`dashboard_api_failed:${response.status}`)
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    throw new Error(`dashboard_api_invalid_response:${response.status}`)
  }
  return (await response.json()) as DashboardSnapshot
}

export interface TopupResult {
  tx_hash: string
  credited_micro_usd: number
  balance_micro_usd: number
  burned_myc_raw: string
}

export async function submitTopup(txHash: string, fetchImpl: typeof fetch = fetch): Promise<TopupResult> {
  const response = await fetchImpl('/dashboard/topup', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tx_hash: txHash.trim() }),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(body?.error?.code ?? `topup_failed:${response.status}`)
  }
  return body as TopupResult
}

async function postJson<T>(path: string, payload: unknown, fetchImpl: typeof fetch = fetch): Promise<T> {
  const response = await fetchImpl(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error?.code ?? `request_failed:${response.status}`)
  return body as T
}

export function claimRedpacket(code: string, toAddress: string, fetchImpl: typeof fetch = fetch) {
  return postJson<{ tx_hash: string; amount_myc: number; to_address: string }>(
    '/dashboard/claim',
    { code: code.trim(), to_address: toAddress },
    fetchImpl
  )
}

export function redeemGasless(burnAuth: Record<string, string>, fetchImpl: typeof fetch = fetch) {
  return postJson<TopupResult & { burned_myc: number }>('/dashboard/redeem-gasless', burnAuth, fetchImpl)
}
