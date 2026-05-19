import { createHash, randomUUID } from 'node:crypto'
import { GatewayError } from '../errors.js'

export interface AccountInvite {
  id: string
  accountId: string
  inviteTokenHash: string
  status: 'active' | 'accepted' | 'revoked'
  expiresAt: string
  createdAt: string
  createdBy: string
  acceptedAt?: string | null
}

function tokenFromBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

export function createInviteToken(input: {
  accountId: string
  randomBytes?: Uint8Array
  expiresInSeconds?: number
  createdBy: string
  now: string
}): { invite: AccountInvite; rawToken: string } {
  const rawToken = tokenFromBytes(input.randomBytes ?? crypto.getRandomValues(new Uint8Array(32)))
  const expiresInSeconds = input.expiresInSeconds ?? 7 * 24 * 60 * 60
  const invite: AccountInvite = {
    id: randomUUID(),
    accountId: input.accountId,
    inviteTokenHash: hashDashboardToken(rawToken),
    status: 'active',
    expiresAt: new Date(Date.parse(input.now) + expiresInSeconds * 1000).toISOString(),
    createdAt: input.now,
    createdBy: input.createdBy,
    acceptedAt: null,
  }
  return { invite, rawToken }
}

export function hashDashboardToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex')
}

export function acceptInvite(input: {
  inviteTokenHash: string
  invites: AccountInvite[]
  now: string
}): { inviteId: string; accountId: string } {
  const invite = input.invites.find((candidate) => candidate.inviteTokenHash === input.inviteTokenHash)
  if (!invite) throw new GatewayError('invite_not_found', 404)
  if (invite.status !== 'active') throw new GatewayError('invite_not_active', 409)
  if (Date.parse(invite.expiresAt) <= Date.parse(input.now)) throw new GatewayError('invite_expired', 410)
  invite.status = 'accepted'
  return { inviteId: invite.id, accountId: invite.accountId }
}

export function createDashboardSession(input: {
  accountId: string
  authMethod: 'passkey' | 'magic_link'
  randomBytes?: Uint8Array
  now: string
}) {
  const rawSession = tokenFromBytes(input.randomBytes ?? crypto.getRandomValues(new Uint8Array(32)))
  return {
    id: randomUUID(),
    accountId: input.accountId,
    sessionToken: rawSession,
    sessionHash: hashDashboardToken(rawSession),
    authMethod: input.authMethod,
    scope: 'dashboard' as const,
    status: 'active' as const,
    createdAt: input.now,
    expiresAt: new Date(Date.parse(input.now) + 30 * 24 * 60 * 60 * 1000).toISOString(),
  }
}

export function createCreditRequest(input: {
  accountId: string
  requestedMicroUsd: number
  message?: string
  now: string
}) {
  if (!Number.isInteger(input.requestedMicroUsd) || input.requestedMicroUsd <= 0) {
    throw new GatewayError('invalid_credit_request_amount', 400)
  }
  return {
    id: randomUUID(),
    accountId: input.accountId,
    requestedMicroUsd: input.requestedMicroUsd,
    message: input.message,
    status: 'pending' as const,
    createdAt: input.now,
  }
}
