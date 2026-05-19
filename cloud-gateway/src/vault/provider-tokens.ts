import { envelopeDecrypt, envelopeEncrypt } from './envelope.js'
import type { ProviderTokenStatus, ProviderTokenSummary } from '../types.js'

export interface ProviderTokenRecord extends ProviderTokenSummary {
  label: string
  scopeJson?: string
  secretRef?: string
  ciphertext: string
  nonce: string
  keyVersion: string
  derivationFingerprint?: string
  lastUsedAt?: string
  rotatedAt?: string
  createdAt: string
  updatedAt: string
}

export async function encryptProviderToken(input: {
  id: string
  provider: string
  label: string
  adapter: string
  plaintext: string
  masterKeys: Record<string, Uint8Array>
  keyVersion: string
  now?: string
}): Promise<ProviderTokenRecord> {
  const encrypted = await envelopeEncrypt({
    plaintext: input.plaintext,
    masterKeys: input.masterKeys,
    keyVersion: input.keyVersion,
  })
  const now = input.now ?? new Date().toISOString()
  return {
    id: input.id,
    provider: input.provider,
    label: input.label,
    adapter: input.adapter,
    status: 'active',
    exhaustedUntil: null,
    successCount: 0,
    failureCount: 0,
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce,
    keyVersion: encrypted.keyVersion,
    createdAt: now,
    updatedAt: now,
  }
}

export async function decryptProviderToken(
  record: Pick<ProviderTokenRecord, 'ciphertext' | 'nonce' | 'keyVersion'>,
  masterKeys: Record<string, Uint8Array>
): Promise<string> {
  return envelopeDecrypt({
    encrypted: {
      ciphertext: record.ciphertext,
      nonce: record.nonce,
      keyVersion: record.keyVersion,
    },
    masterKeys,
  })
}

export function updateProviderTokenHealth(input: {
  token: ProviderTokenSummary
  statusCode: number
  latencyMs: number
  now: string
}): ProviderTokenSummary {
  const success = input.statusCode >= 200 && input.statusCode < 400
  const next: ProviderTokenSummary = {
    ...input.token,
    successCount: (input.token.successCount ?? 0) + (success ? 1 : 0),
    failureCount: (input.token.failureCount ?? 0) + (success ? 0 : 1),
    lastResponseMs: input.latencyMs,
    lastError: success ? undefined : `http_${input.statusCode}`,
  }

  if (input.statusCode === 401 || input.statusCode === 403) {
    next.status = 'disabled' as ProviderTokenStatus
  }

  if (input.statusCode === 429) {
    next.exhaustedUntil = new Date(Date.parse(input.now) + 5 * 60 * 1000).toISOString()
  }

  return next
}
