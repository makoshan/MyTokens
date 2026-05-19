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
