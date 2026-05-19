import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptInvite, createCreditRequest, createDashboardSession } from '../src/routes/dashboard.js'

test('dashboard invite creates an account-scoped session and credit request without admin rights', () => {
  const invite = acceptInvite({
    inviteTokenHash: 'hash-1',
    invites: [
      {
        id: 'invite-1',
        accountId: 'acct-1',
        inviteTokenHash: 'hash-1',
        status: 'active',
        expiresAt: '2026-05-20T00:00:00Z',
        createdAt: '2026-05-19T00:00:00Z',
        createdBy: 'admin',
      },
    ],
    now: '2026-05-19T00:00:00Z',
  })
  const session = createDashboardSession({
    accountId: invite.accountId,
    authMethod: 'passkey',
    randomBytes: new Uint8Array(32).fill(3),
    now: '2026-05-19T00:00:00Z',
  })
  const request = createCreditRequest({
    accountId: invite.accountId,
    requestedMicroUsd: 5_000_000,
    message: 'alpha topup',
    now: '2026-05-19T00:00:00Z',
  })

  assert.equal(session.accountId, 'acct-1')
  assert.equal(session.scope, 'dashboard')
  assert.equal(request.status, 'pending')
  assert.equal(request.requestedMicroUsd, 5_000_000)
})
