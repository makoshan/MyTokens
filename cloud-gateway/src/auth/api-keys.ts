import { createHmac, randomBytes as nodeRandomBytes } from 'node:crypto'
import type { ApiKeyRecord } from '../types.js'

export type ApiKeyEnvironment = 'live' | 'test'

export interface CreatedApiKey {
  rawKey: string
  prefix: string
  last4: string
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function timingSafeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return createHmac('sha256', 'compare').update(left).digest('hex') === createHmac('sha256', 'compare').update(right).digest('hex')
}

export function createApiKey(input: {
  environment: ApiKeyEnvironment
  randomBytes?: Uint8Array
}): CreatedApiKey {
  const prefix = `sk-mykey_${input.environment}`
  const entropy = input.randomBytes ?? nodeRandomBytes(32)
  const rawKey = `${prefix}_${base64Url(entropy)}`
  return { rawKey, prefix, last4: rawKey.slice(-4) }
}

export function hashApiKey(rawKey: string, pepper: string): string {
  return createHmac('sha256', pepper).update(rawKey).digest('hex')
}

export function registerApiKey(input: {
  id: string
  accountId: string
  rawKey: string
  pepper: string
  now: string
  scope?: string
  name?: string
}): ApiKeyRecord {
  const parts = input.rawKey.split('_')
  const keyPrefix = parts.length >= 2 ? `${parts[0]}_${parts[1]}` : 'sk-mykey_unknown'
  return {
    id: input.id,
    accountId: input.accountId,
    name: input.name,
    keyPrefix,
    keyLast4: input.rawKey.slice(-4),
    keyHash: hashApiKey(input.rawKey, input.pepper),
    scope: input.scope ?? 'compat_api',
    derivationMode: 'random',
    status: 'active',
    createdAt: input.now,
  }
}

export async function verifyApiKey(input: {
  authorizationHeader: string | null | undefined
  pepper: string
  findByHash: (hash: string) => Promise<ApiKeyRecord | null>
  now?: string
}): Promise<
  | { ok: true; accountId: string; apiKey: ApiKeyRecord }
  | { ok: false; reason: 'missing' | 'malformed' | 'not_found' | 'revoked' | 'expired' }
> {
  const header = input.authorizationHeader
  if (!header) return { ok: false, reason: 'missing' }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match || !match[1].startsWith('sk-mykey_')) return { ok: false, reason: 'malformed' }

  const hash = hashApiKey(match[1], input.pepper)
  const apiKey = await input.findByHash(hash)
  if (!apiKey || !timingSafeEqualText(apiKey.keyHash, hash)) return { ok: false, reason: 'not_found' }
  if (apiKey.status !== 'active') return { ok: false, reason: 'revoked' }
  if (apiKey.expiresAt && Date.parse(apiKey.expiresAt) <= Date.parse(input.now ?? new Date().toISOString())) {
    return { ok: false, reason: 'expired' }
  }

  return { ok: true, accountId: apiKey.accountId, apiKey }
}
