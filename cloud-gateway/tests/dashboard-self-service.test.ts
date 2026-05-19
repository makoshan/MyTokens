import assert from 'node:assert/strict'
import test from 'node:test'
import { createGatewayApp } from '../src/index.js'
import { InMemoryGatewayStore } from '../src/db/store.js'

function seedStore() {
  return new InMemoryGatewayStore({
    baseUrl: 'https://api.mykey.example',
    accounts: [
      {
        id: 'acct-1',
        displayName: 'Friend Agent',
        status: 'active',
        accountGroup: 'friends',
        balanceMicroUsd: 1_000_000,
        reservedMicroUsd: 0,
        defaultProvider: 'openai',
        defaultModel: 'gpt-4.1-mini',
        createdAt: '2026-05-19T00:00:00Z',
        updatedAt: '2026-05-19T00:00:00Z',
      },
      {
        id: 'acct-2',
        displayName: 'Other Account',
        status: 'active',
        accountGroup: 'friends',
        balanceMicroUsd: 500_000,
        reservedMicroUsd: 0,
        defaultProvider: 'openai',
        defaultModel: 'gpt-4.1-mini',
        createdAt: '2026-05-19T00:00:00Z',
        updatedAt: '2026-05-19T00:00:00Z',
      },
    ],
  })
}

function appOptions(store: InMemoryGatewayStore) {
  return {
    store,
    pepper: 'test-pepper',
    adminToken: 'admin-secret',
    baseUrl: 'https://dashboard.mykey.example',
    now: () => '2026-05-19T00:00:00Z',
  }
}

async function createInvite(app: ReturnType<typeof createGatewayApp>, accountId: string) {
  const response = await app.fetch(
    new Request(`https://gateway.test/admin/accounts/${accountId}/invites`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
  )
  assert.equal(response.status, 201)
  return (await response.json()) as {
    id: string
    invite_token: string
    invite_url: string
    expires_at: string
    status: string
  }
}

async function acceptInviteOverHttp(app: ReturnType<typeof createGatewayApp>, inviteToken: string) {
  return app.fetch(
    new Request('https://gateway.test/dashboard/invites/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invite_token: inviteToken }),
    })
  )
}

test('admin creates an invite that the dashboard accepts exactly once and exchanges for a session', async () => {
  const store = seedStore()
  const app = createGatewayApp(appOptions(store))

  const invite = await createInvite(app, 'acct-1')
  assert.match(invite.invite_url, /\/accept\?token=/)
  assert.equal(invite.status, 'active')

  const accept = await acceptInviteOverHttp(app, invite.invite_token)
  const acceptPayload = (await accept.json()) as { account_id: string; session_token: string; expires_at: string }
  assert.equal(accept.status, 200)
  assert.equal(acceptPayload.account_id, 'acct-1')
  assert.ok(acceptPayload.session_token.length > 16)
  const cookie = accept.headers.get('set-cookie')
  assert.ok(cookie && cookie.includes('HttpOnly'))
  assert.ok(cookie && cookie.includes('Secure'))
  assert.ok(cookie && cookie.includes('SameSite=Strict'))

  const replay = await acceptInviteOverHttp(app, invite.invite_token)
  assert.equal(replay.status, 409)

  const me = await app.fetch(
    new Request('https://gateway.test/dashboard/me', {
      headers: { 'x-dashboard-session': acceptPayload.session_token },
    })
  )
  assert.equal(me.status, 200)
  const mePayload = (await me.json()) as { account: { id: string } }
  assert.equal(mePayload.account.id, 'acct-1')
})

test('dashboard self-service issues a one-time raw API key that authenticates the buyer API', async () => {
  const store = seedStore()
  const app = createGatewayApp(appOptions(store))
  const invite = await createInvite(app, 'acct-1')
  const accept = await acceptInviteOverHttp(app, invite.invite_token)
  const { session_token: sessionToken } = (await accept.json()) as { session_token: string }

  const created = await app.fetch(
    new Request('https://gateway.test/dashboard/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dashboard-session': sessionToken },
      body: JSON.stringify({ name: 'cli token' }),
    })
  )
  assert.equal(created.status, 201)
  const createdPayload = (await created.json()) as { id: string; raw_key: string; status: string }
  assert.match(createdPayload.raw_key, /^sk-mykey_live_/)
  assert.equal(createdPayload.status, 'active')

  const balance = await app.fetch(
    new Request('https://gateway.test/v1/balance', {
      headers: { authorization: `Bearer ${createdPayload.raw_key}` },
    })
  )
  assert.equal(balance.status, 200)
})

test('revoking an API key from the dashboard immediately denies further buyer API calls', async () => {
  const store = seedStore()
  const app = createGatewayApp(appOptions(store))
  const invite = await createInvite(app, 'acct-1')
  const accept = await acceptInviteOverHttp(app, invite.invite_token)
  const { session_token: sessionToken } = (await accept.json()) as { session_token: string }

  const created = await app.fetch(
    new Request('https://gateway.test/dashboard/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dashboard-session': sessionToken },
      body: JSON.stringify({}),
    })
  )
  const { id: keyId, raw_key: rawKey } = (await created.json()) as { id: string; raw_key: string }

  const revoke = await app.fetch(
    new Request(`https://gateway.test/dashboard/api-keys/${keyId}/revoke`, {
      method: 'POST',
      headers: { 'x-dashboard-session': sessionToken },
    })
  )
  const revokePayload = (await revoke.json()) as { status: string; revoked_at: string }
  assert.equal(revoke.status, 200)
  assert.equal(revokePayload.status, 'revoked')
  assert.equal(revokePayload.revoked_at, '2026-05-19T00:00:00Z')

  const blocked = await app.fetch(
    new Request('https://gateway.test/v1/balance', {
      headers: { authorization: `Bearer ${rawKey}` },
    })
  )
  assert.equal(blocked.status, 403)
})

test('dashboard cannot revoke another account API key', async () => {
  const store = seedStore()
  const app = createGatewayApp(appOptions(store))
  const inviteOne = await createInvite(app, 'acct-1')
  const acceptOne = await acceptInviteOverHttp(app, inviteOne.invite_token)
  const { session_token: sessionTokenOne } = (await acceptOne.json()) as { session_token: string }
  const inviteTwo = await createInvite(app, 'acct-2')
  const acceptTwo = await acceptInviteOverHttp(app, inviteTwo.invite_token)
  const { session_token: sessionTokenTwo } = (await acceptTwo.json()) as { session_token: string }

  const ownKey = await app.fetch(
    new Request('https://gateway.test/dashboard/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dashboard-session': sessionTokenOne },
      body: JSON.stringify({}),
    })
  )
  const { id: keyId } = (await ownKey.json()) as { id: string }

  const crossRevoke = await app.fetch(
    new Request(`https://gateway.test/dashboard/api-keys/${keyId}/revoke`, {
      method: 'POST',
      headers: { 'x-dashboard-session': sessionTokenTwo },
    })
  )
  assert.equal(crossRevoke.status, 404)
})

test('admin can revoke any account API key and the key stops authenticating', async () => {
  const store = seedStore()
  const app = createGatewayApp(appOptions(store))
  const invite = await createInvite(app, 'acct-1')
  const accept = await acceptInviteOverHttp(app, invite.invite_token)
  const { session_token: sessionToken } = (await accept.json()) as { session_token: string }
  const created = await app.fetch(
    new Request('https://gateway.test/dashboard/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dashboard-session': sessionToken },
      body: JSON.stringify({}),
    })
  )
  const { id: keyId, raw_key: rawKey } = (await created.json()) as { id: string; raw_key: string }

  const adminRevoke = await app.fetch(
    new Request(`https://gateway.test/admin/api-keys/${keyId}/revoke`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret' },
    })
  )
  assert.equal(adminRevoke.status, 200)

  const blocked = await app.fetch(
    new Request('https://gateway.test/v1/balance', {
      headers: { authorization: `Bearer ${rawKey}` },
    })
  )
  assert.equal(blocked.status, 403)

  const missing = await app.fetch(
    new Request('https://gateway.test/admin/api-keys/key_missing/revoke', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret' },
    })
  )
  assert.equal(missing.status, 404)
})
