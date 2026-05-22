import type { ApiKeyStatus, DashboardApiKey, DashboardSnapshot } from './types.js'

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

interface DashboardApiKeyResponse {
  id: string
  name?: string | null
  raw_key?: string
  prefix: string
  last4: string
  status: ApiKeyStatus
  created_at: string
}

function mapDashboardApiKey(row: DashboardApiKeyResponse): DashboardApiKey {
  return {
    id: row.id,
    name: row.name?.trim() || 'MyKey API key',
    prefix: row.prefix,
    last4: row.last4,
    status: row.status,
    createdAt: row.created_at,
  }
}

export async function createDashboardApiKey(
  name: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ key: DashboardApiKey; rawKey: string }> {
  const body = name.trim() ? { name: name.trim() } : {}
  const response = await postJson<DashboardApiKeyResponse>('/dashboard/api-keys', body, fetchImpl)
  if (!response.raw_key) throw new Error('api_key_missing_raw_key')
  return {
    key: mapDashboardApiKey(response),
    rawKey: response.raw_key,
  }
}

export async function revokeDashboardApiKey(
  keyId: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ id: string; status: ApiKeyStatus; revokedAt?: string }> {
  const response = await postJson<{ id: string; status: ApiKeyStatus; revoked_at?: string }>(
    `/dashboard/api-keys/${encodeURIComponent(keyId)}/revoke`,
    {},
    fetchImpl
  )
  return { id: response.id, status: response.status, revokedAt: response.revoked_at }
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

export interface OnchainConfig {
  chain_id: number
  myc_token: string | null
  stablecoin_token: string | null
  stablecoin_decimals: number
  relayer_address: string | null
  faucet_enabled: boolean
}

export async function loadOnchainConfig(fetchImpl: typeof fetch = fetch): Promise<OnchainConfig> {
  const res = await fetchImpl('/dashboard/onchain-config', { credentials: 'include' })
  if (!res.ok) throw new Error(`onchain_config_failed:${res.status}`)
  return (await res.json()) as OnchainConfig
}

export interface BuyMycResult {
  stablecoin_tx_hash: string
  tx_hash: string
  paid_usdt: number
  bought_myc: number
  to_address: string
}

// Buy MYC with a passkey-signed stablecoin transfer (gasless). The gateway pays
// the relayer's gas; the buyer only signs.
export function buyMyc(auth: Record<string, string>, fetchImpl: typeof fetch = fetch) {
  return postJson<BuyMycResult>('/dashboard/buy-myc', auth, fetchImpl)
}

// Testnet faucet: mint test-USDT to the wallet so the buy flow can be exercised.
export function faucetUsdt(toAddress: string, fetchImpl: typeof fetch = fetch) {
  return postJson<{ tx_hash: string; minted_usdt: number; to_address: string }>(
    '/dashboard/faucet-usdt',
    { to_address: toAddress },
    fetchImpl
  )
}

export interface ChatResult {
  text: string
  raw: unknown
}

interface RawResponse {
  ok: boolean
  status: number
  body: any
}

async function rawPost(path: string, payload: unknown, fetchImpl: typeof fetch): Promise<RawResponse> {
  const response = await fetchImpl(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json().catch(() => null)
  return { ok: response.ok, status: response.status, body }
}

// Pull the assistant's text out of whichever shape the upstream returned
// (OpenAI Responses, OpenAI chat completions, or Anthropic messages).
export function extractAssistantText(payload: any): string {
  if (!payload || typeof payload !== 'object') return ''
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) return payload.output_text
  if (Array.isArray(payload.output)) {
    const parts: string[] = []
    for (const item of payload.output) {
      const content = item?.content
      if (Array.isArray(content)) {
        for (const chunk of content) {
          if (typeof chunk?.text === 'string') parts.push(chunk.text)
          else if (typeof chunk?.text?.value === 'string') parts.push(chunk.text.value)
        }
      }
    }
    if (parts.length) return parts.join('')
  }
  if (Array.isArray(payload.content)) {
    const parts = payload.content
      .filter((chunk: any) => typeof chunk?.text === 'string')
      .map((chunk: any) => chunk.text)
    if (parts.length) return parts.join('')
  }
  const choiceMessage = payload.choices?.[0]?.message?.content
  if (typeof choiceMessage === 'string' && choiceMessage.trim()) return choiceMessage
  return ''
}

// Web AI chat: relay through the dashboard session (no API key needed). Use
// OpenAI-compatible chat completions first because shared channels such as
// BaiLian/Kimi expose that shape; Anthropic-routed models are retried via
// Messages after the gateway rejects the adapter before billing.
export async function sendChat(
  model: string,
  prompt: string,
  fetchImpl: typeof fetch = fetch
): Promise<ChatResult> {
  let res = await rawPost(
    '/dashboard/chat/completions',
    { model, messages: [{ role: 'user', content: prompt }] },
    fetchImpl
  )
  if (res.status === 503 && res.body?.error?.code === 'route_provider_adapter_mismatch') {
    res = await rawPost(
      '/dashboard/messages',
      { model, messages: [{ role: 'user', content: prompt }], max_tokens: 1024 },
      fetchImpl
    )
  }
  if (!res.ok) {
    throw new Error(res.body?.error?.code ?? `chat_failed:${res.status}`)
  }
  return { text: extractAssistantText(res.body), raw: res.body }
}
