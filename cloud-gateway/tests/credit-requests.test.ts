import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryGatewayStore } from '../src/db/store.js'
import { createGatewayApp } from '../src/index.js'

function seedStore() {
  return new InMemoryGatewayStore({
    baseUrl: 'https://api.mykey.example',
    accounts: [
      {
        id: 'acct-1',
        displayName: 'Buyer A',
        status: 'active',
        accountGroup: 'friends',
        balanceMicroUsd: 1_000_000,
        reservedMicroUsd: 0,
        defaultProvider: 'openai',
        defaultModel: 'gpt-4.1-mini',
        createdAt: '2026-05-20T00:00:00Z',
        updatedAt: '2026-05-20T00:00:00Z',
      },
      {
        id: 'acct-2',
        displayName: 'Buyer B',
        status: 'active',
        accountGroup: 'friends',
        balanceMicroUsd: 500_000,
        reservedMicroUsd: 0,
        defaultProvider: 'openai',
        defaultModel: 'gpt-4.1-mini',
        createdAt: '2026-05-20T00:00:00Z',
        updatedAt: '2026-05-20T00:00:00Z',
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
    now: () => '2026-05-20T00:00:00Z',
  }
}

async function inviteAcceptFor(app: ReturnType<typeof createGatewayApp>, accountId: string) {
  const invite = await app.fetch(
    new Request(`https://gateway.test/admin/accounts/${accountId}/invites`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
  )
  const { invite_token } = (await invite.json()) as { invite_token: string }
  const accept = await app.fetch(
    new Request('https://gateway.test/dashboard/invites/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invite_token }),
    })
  )
  const { session_token } = (await accept.json()) as { session_token: string }
  return session_token
}

test('dashboard submits a credit request and admin lists pending', async () => {
  const store = seedStore()
  const app = createGatewayApp(appOptions(store))
  const sessionToken = await inviteAcceptFor(app, 'acct-1')

  const submit = await app.fetch(
    new Request('https://gateway.test/dashboard/credit-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dashboard-session': sessionToken },
      body: JSON.stringify({ requested_micro_usd: 2_500_000, message: 'top up please' }),
    })
  )
  const submitPayload = (await submit.json()) as { id: string; status: string; account_id: string }
  assert.equal(submit.status, 201)
  assert.equal(submitPayload.status, 'pending')
  assert.equal(submitPayload.account_id, 'acct-1')

  const adminList = await app.fetch(
    new Request('https://gateway.test/admin/credit-requests?status=pending', {
      headers: { authorization: 'Bearer admin-secret' },
    })
  )
  const adminPayload = (await adminList.json()) as { data: Array<{ id: string }> }
  assert.equal(adminList.status, 200)
  assert.equal(adminPayload.data.length, 1)
  assert.equal(adminPayload.data[0].id, submitPayload.id)
})

test('admin approve credits the buyer balance and writes a cr_<id> ledger entry', async () => {
  const store = seedStore()
  const app = createGatewayApp(appOptions(store))
  const sessionToken = await inviteAcceptFor(app, 'acct-1')

  const submit = await app.fetch(
    new Request('https://gateway.test/dashboard/credit-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dashboard-session': sessionToken },
      body: JSON.stringify({ requested_micro_usd: 2_500_000 }),
    })
  )
  const { id } = (await submit.json()) as { id: string }

  const approve = await app.fetch(
    new Request(`https://gateway.test/admin/credit-requests/${id}/approve`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret' },
    })
  )
  const approvePayload = (await approve.json()) as { status: string; resolved_by: string }
  assert.equal(approve.status, 200)
  assert.equal(approvePayload.status, 'approved')
  assert.equal(approvePayload.resolved_by, 'admin')

  const account = await store.getAccount('acct-1')
  assert.equal(account?.balanceMicroUsd, 1_000_000 + 2_500_000)
  const ledgerEntry = store.ledger.find((row) => row.id === `cr_${id}`)
  assert.ok(ledgerEntry, 'ledger entry must use cr_<id> as primary key')
  assert.equal(ledgerEntry?.amountMicroUsd, 2_500_000)
})

test('repeated approve returns 409 with current state and does not double-credit', async () => {
  const store = seedStore()
  const app = createGatewayApp(appOptions(store))
  const sessionToken = await inviteAcceptFor(app, 'acct-1')
  const submit = await app.fetch(
    new Request('https://gateway.test/dashboard/credit-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dashboard-session': sessionToken },
      body: JSON.stringify({ requested_micro_usd: 1_500_000 }),
    })
  )
  const { id } = (await submit.json()) as { id: string }

  await app.fetch(
    new Request(`https://gateway.test/admin/credit-requests/${id}/approve`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret' },
    })
  )

  const replay = await app.fetch(
    new Request(`https://gateway.test/admin/credit-requests/${id}/approve`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret' },
    })
  )
  const replayPayload = (await replay.json()) as { status: string }
  assert.equal(replay.status, 409)
  assert.equal(replayPayload.status, 'approved')

  const account = await store.getAccount('acct-1')
  assert.equal(account?.balanceMicroUsd, 1_000_000 + 1_500_000)
  const ledgerHits = store.ledger.filter((row) => row.id === `cr_${id}`)
  assert.equal(ledgerHits.length, 1, 'cr_<id> ledger entry must remain singular under replay')
})

test('rejected credit request cannot be approved afterwards', async () => {
  const store = seedStore()
  const app = createGatewayApp(appOptions(store))
  const sessionToken = await inviteAcceptFor(app, 'acct-1')
  const submit = await app.fetch(
    new Request('https://gateway.test/dashboard/credit-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dashboard-session': sessionToken },
      body: JSON.stringify({ requested_micro_usd: 500_000 }),
    })
  )
  const { id } = (await submit.json()) as { id: string }

  const reject = await app.fetch(
    new Request(`https://gateway.test/admin/credit-requests/${id}/reject`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret' },
    })
  )
  const rejectPayload = (await reject.json()) as { status: string }
  assert.equal(reject.status, 200)
  assert.equal(rejectPayload.status, 'rejected')

  const followup = await app.fetch(
    new Request(`https://gateway.test/admin/credit-requests/${id}/approve`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret' },
    })
  )
  assert.equal(followup.status, 409)
  const account = await store.getAccount('acct-1')
  assert.equal(account?.balanceMicroUsd, 1_000_000)
})

test('dashboard cannot see another account credit requests', async () => {
  const store = seedStore()
  const app = createGatewayApp(appOptions(store))
  const sessionA = await inviteAcceptFor(app, 'acct-1')
  const sessionB = await inviteAcceptFor(app, 'acct-2')

  await app.fetch(
    new Request('https://gateway.test/dashboard/credit-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dashboard-session': sessionA },
      body: JSON.stringify({ requested_micro_usd: 100_000 }),
    })
  )

  const list = await app.fetch(
    new Request('https://gateway.test/dashboard/credit-requests', {
      headers: { 'x-dashboard-session': sessionB },
    })
  )
  const payload = (await list.json()) as { data: unknown[] }
  assert.equal(payload.data.length, 0)
})

test('non-positive or non-integer requested amount returns 400', async () => {
  const store = seedStore()
  const app = createGatewayApp(appOptions(store))
  const sessionToken = await inviteAcceptFor(app, 'acct-1')

  for (const amount of [0, -10, 1.5, 'big']) {
    const response = await app.fetch(
      new Request('https://gateway.test/dashboard/credit-requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dashboard-session': sessionToken },
        body: JSON.stringify({ requested_micro_usd: amount }),
      })
    )
    assert.equal(response.status, 400, `amount=${String(amount)} should be rejected`)
  }
})

test('dashboard /me snapshot exposes the current account credit requests', async () => {
  const store = seedStore()
  const app = createGatewayApp(appOptions(store))
  const sessionToken = await inviteAcceptFor(app, 'acct-1')
  await app.fetch(
    new Request('https://gateway.test/dashboard/credit-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dashboard-session': sessionToken },
      body: JSON.stringify({ requested_micro_usd: 200_000, message: 'snapshot test' }),
    })
  )

  const me = await app.fetch(
    new Request('https://gateway.test/dashboard/me', {
      headers: { 'x-dashboard-session': sessionToken },
    })
  )
  const payload = (await me.json()) as { creditRequests: Array<{ status: string; requestedMicroUsd: number }> }
  assert.equal(me.status, 200)
  assert.equal(payload.creditRequests.length, 1)
  assert.equal(payload.creditRequests[0].status, 'pending')
  assert.equal(payload.creditRequests[0].requestedMicroUsd, 200_000)
})
