import assert from 'node:assert/strict'
import test from 'node:test'
import { createGatewayApp, type GatewayAppOptions } from '../src/index.js'
import { InMemoryGatewayStore } from '../src/db/store.js'

const FAKE_TX = `0x${'a'.repeat(64)}` as const
// 0x + exactly 40 hex chars (echoes the user's real 0x373f…D80B passkey wallet).
const VALID_ADDRESS = '0x373f1234567890abcdef1234567890abcdef0d80'

function seedStore() {
  return new InMemoryGatewayStore({
    baseUrl: 'https://api.mykey.example',
    accounts: [
      {
        id: 'acct-1',
        displayName: 'Friend Agent',
        status: 'active',
        accountGroup: 'friends',
        balanceMicroUsd: 0,
        reservedMicroUsd: 0,
        defaultProvider: 'openai',
        defaultModel: 'gpt-4.1-mini',
        createdAt: '2026-05-19T00:00:00Z',
        updatedAt: '2026-05-19T00:00:00Z',
      },
    ],
  })
}

/** Records every relayer.transfer invocation so tests can assert on-chain args without a live RPC. */
function stubRelayer() {
  const calls: Array<{ to: string; amountRaw: bigint }> = []
  return {
    calls,
    transfer: async (_env: unknown, to: string, amountRaw: bigint) => {
      calls.push({ to, amountRaw })
      return FAKE_TX
    },
  }
}

function appOptions(store: InMemoryGatewayStore, relayer: GatewayAppOptions['relayer']): GatewayAppOptions {
  return {
    store,
    pepper: 'test-pepper',
    adminToken: 'admin-secret',
    baseUrl: 'https://dashboard.mykey.example',
    now: () => '2026-05-19T00:00:00Z',
    relayer,
  }
}

type App = ReturnType<typeof createGatewayApp>

async function openSession(app: App): Promise<string> {
  const invite = await app.fetch(
    new Request('https://gateway.test/admin/accounts/acct-1/invites', {
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

async function createRedpacket(app: App, amountMyc: number): Promise<string> {
  const res = await app.fetch(
    new Request('https://gateway.test/admin/redpackets', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ amount_myc: amountMyc }),
    })
  )
  assert.equal(res.status, 201)
  const { code } = (await res.json()) as { code: string }
  return code
}

function claim(app: App, session: string, body: Record<string, unknown>) {
  return app.fetch(
    new Request('https://gateway.test/dashboard/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dashboard-session': session },
      body: JSON.stringify(body),
    })
  )
}

test('a buyer claims a red packet once: relayer transfers the exact MYC amount and the packet is consumed', async () => {
  const store = seedStore()
  const relayer = stubRelayer()
  const app = createGatewayApp(appOptions(store, relayer))
  const session = await openSession(app)
  const code = await createRedpacket(app, 20)

  const res = await claim(app, session, { code, to_address: VALID_ADDRESS })
  assert.equal(res.status, 200)
  const payload = (await res.json()) as { tx_hash: string; amount_myc: number; to_address: string }
  assert.equal(payload.tx_hash, FAKE_TX)
  assert.equal(payload.amount_myc, 20)
  assert.equal(payload.to_address, VALID_ADDRESS)

  // The relayer was asked to move exactly 20 MYC (6-decimal raw) to the buyer.
  assert.equal(relayer.calls.length, 1)
  assert.equal(relayer.calls[0].to, VALID_ADDRESS)
  assert.equal(relayer.calls[0].amountRaw, 20_000_000n)
})

test('claiming an already-claimed red packet is rejected with 409 and does not transfer again', async () => {
  const store = seedStore()
  const relayer = stubRelayer()
  const app = createGatewayApp(appOptions(store, relayer))
  const session = await openSession(app)
  const code = await createRedpacket(app, 10)

  const first = await claim(app, session, { code, to_address: VALID_ADDRESS })
  assert.equal(first.status, 200)

  const second = await claim(app, session, { code, to_address: VALID_ADDRESS })
  assert.equal(second.status, 409)
  // No second on-chain transfer for a consumed packet.
  assert.equal(relayer.calls.length, 1)
})

test('claim rejects a malformed wallet address with 400 before touching the relayer', async () => {
  const store = seedStore()
  const relayer = stubRelayer()
  const app = createGatewayApp(appOptions(store, relayer))
  const session = await openSession(app)
  const code = await createRedpacket(app, 5)

  const res = await claim(app, session, { code, to_address: '0xnot-an-address' })
  assert.equal(res.status, 400)
  assert.equal(relayer.calls.length, 0)
})

test('claim with an unknown code returns 404 and never transfers', async () => {
  const store = seedStore()
  const relayer = stubRelayer()
  const app = createGatewayApp(appOptions(store, relayer))
  const session = await openSession(app)

  const res = await claim(app, session, { code: 'deadbeef'.repeat(5), to_address: VALID_ADDRESS })
  assert.equal(res.status, 404)
  assert.equal(relayer.calls.length, 0)
})

test('claim without a dashboard session is rejected', async () => {
  const store = seedStore()
  const relayer = stubRelayer()
  const app = createGatewayApp(appOptions(store, relayer))
  const code = await createRedpacket(app, 5)

  const res = await app.fetch(
    new Request('https://gateway.test/dashboard/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, to_address: VALID_ADDRESS }),
    })
  )
  assert.equal(res.status, 401)
  assert.equal(relayer.calls.length, 0)
})

// Regression: the combined `/accept?token=...&redpacket=...` invite link must
// preserve the red-packet code through the 302 so the SPA can auto-open the
// claim overlay. A prior version hardcoded `location: '/'` and dropped it.
test('GET /accept preserves ?redpacket= through the login redirect', async () => {
  const store = seedStore()
  const app = createGatewayApp(appOptions(store, stubRelayer()))

  const invite = await app.fetch(
    new Request('https://gateway.test/admin/accounts/acct-1/invites', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
  )
  const { invite_token } = (await invite.json()) as { invite_token: string }

  const res = await app.fetch(
    new Request(`https://gateway.test/accept?token=${invite_token}&redpacket=abc123`, { redirect: 'manual' })
  )
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), '/?redpacket=abc123')
  assert.ok(res.headers.get('set-cookie')?.includes('mykey_dashboard_session='))
})

test('GET /accept without a red-packet code lands at the bare root', async () => {
  const store = seedStore()
  const app = createGatewayApp(appOptions(store, stubRelayer()))

  const invite = await app.fetch(
    new Request('https://gateway.test/admin/accounts/acct-1/invites', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
  )
  const { invite_token } = (await invite.json()) as { invite_token: string }

  const res = await app.fetch(
    new Request(`https://gateway.test/accept?token=${invite_token}`, { redirect: 'manual' })
  )
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), '/')
})

// Regression for the claim double-spend race: the route used to transfer MYC
// *before* marking the packet claimed, so two concurrent requests with the same
// code could both pass the unclaimed check and both pull from the relayer pool.
// The fix wins the claim atomically before transferring.
test('concurrent claims of one code transfer exactly once (no double spend)', async () => {
  const store = seedStore()
  const relayer = stubRelayer()
  const app = createGatewayApp(appOptions(store, relayer))
  const session = await openSession(app)
  const code = await createRedpacket(app, 1)

  const results = await Promise.all(
    Array.from({ length: 5 }, () => claim(app, session, { code, to_address: VALID_ADDRESS }))
  )
  const statuses = results.map((r) => r.status)
  assert.equal(statuses.filter((s) => s === 200).length, 1, 'exactly one claim wins')
  assert.equal(statuses.filter((s) => s === 409).length, 4, 'the rest are already_claimed')
  assert.equal(relayer.calls.length, 1, 'the relayer pool is touched exactly once')

  const [row] = await store.listRedpackets()
  assert.equal(row.status, 'claimed')
  assert.equal(row.claimTxHash, FAKE_TX)
})

test('store.claimRedpacket is atomic: only the first concurrent caller wins', async () => {
  const store = seedStore()
  await store.createRedpacket({
    id: 'rp_atomic',
    codeHash: 'hash',
    amountRaw: '1000000',
    status: 'unclaimed',
    createdAt: '2026-05-19T00:00:00Z',
  })
  const outcomes = await Promise.all([
    store.claimRedpacket({ id: 'rp_atomic', account: 'a', toAddress: VALID_ADDRESS, now: 'n' }),
    store.claimRedpacket({ id: 'rp_atomic', account: 'b', toAddress: VALID_ADDRESS, now: 'n' }),
  ])
  assert.deepEqual([...outcomes].sort(), [false, true])
})

test('a failed relayer transfer releases the packet back to unclaimed', async () => {
  const store = seedStore()
  const failing: GatewayAppOptions['relayer'] = {
    transfer: async () => {
      throw new Error('relayer_boom')
    },
  }
  const app = createGatewayApp(appOptions(store, failing))
  const session = await openSession(app)
  const code = await createRedpacket(app, 1)

  const failed = await claim(app, session, { code, to_address: VALID_ADDRESS })
  assert.notEqual(failed.status, 200)
  const [row] = await store.listRedpackets()
  assert.equal(row.status, 'unclaimed', 'packet is reusable after a failed transfer')
  assert.equal(row.claimTxHash, undefined)

  // A retry on a healthy relayer now succeeds against the same code.
  const healthy = createGatewayApp(appOptions(store, stubRelayer()))
  const session2 = await openSession(healthy)
  const retry = await claim(healthy, session2, { code, to_address: VALID_ADDRESS })
  assert.equal(retry.status, 200)
})
