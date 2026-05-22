import { createHash } from 'node:crypto'
import type { GatewayStore } from './db/store.js'
import type { AdminAuditRecord } from './types.js'

const SENSITIVE_KEYS = new Set([
  'plaintext',
  'raw_key',
  'rawKey',
  'invite_token',
  'inviteToken',
  'session_token',
  'sessionToken',
  'admin_token',
  'adminToken',
  'master_key',
  'masterKey',
  'master_key_v1',
  'MASTER_KEY_V1',
  'password',
  'secret',
])

function scrubSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubSensitive)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.has(key) ? '[redacted]' : scrubSensitive(candidate)
  }
  return out
}

export function hashAuditPayload(body: unknown): string {
  const scrubbed = scrubSensitive(body ?? {})
  return createHash('sha256').update(JSON.stringify(scrubbed)).digest('hex')
}

export async function recordAuditAdminAction(
  store: GatewayStore,
  input: {
    action: string
    targetType: string
    targetId: string
    body?: unknown
    statusCode: number
    now: string
    actor?: string
    extra?: Record<string, unknown>
  }
): Promise<void> {
  const record: AdminAuditRecord = {
    id: `audit_${crypto.randomUUID()}`,
    actor: input.actor ?? 'admin',
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    metadata: {
      payload_hash: input.body !== undefined ? hashAuditPayload(input.body) : null,
      status_code: input.statusCode,
      ...(input.extra ?? {}),
    },
    createdAt: input.now,
  }
  try {
    await store.recordAdminAudit(record)
  } catch (error) {
    // Best-effort: never break admin operations because audit logging failed.
    // The error surfaces in Worker logs (wrangler tail) for ops follow-up.
    console.error('admin_audit_log_failed', { action: input.action, error: String(error) })
  }
}
