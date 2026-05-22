export const OKLINK_DOCS_URL = 'https://www.oklink.com/docs/zh/#explorer-introduction'
export const OKLINK_EXPLORER_BASE_URL = 'https://www.oklink.com'

export function buildOklinkExplorerUrl(path: string, params: Record<string, string>): string {
  if (!path.startsWith('/api/v5/explorer/')) {
    throw new Error('OKLink API path must start with /api/v5/explorer/')
  }
  const url = new URL(path, OKLINK_EXPLORER_BASE_URL)
  Object.entries(params).forEach(([key, value]) => {
    if (value.trim()) url.searchParams.set(key, value)
  })
  return url.toString()
}

export function maskOklinkApiKey(apiKey: string): string {
  const key = apiKey.trim()
  if (key.length <= 8) return '••••••'
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}
