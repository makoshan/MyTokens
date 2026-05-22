import assert from 'node:assert/strict'
import test from 'node:test'
import { privateKeyToAccount } from 'viem/accounts'
import { createGatewayApp, type GatewayAppOptions } from '../src/index.js'
import { InMemoryGatewayStore } from '../src/db/store.js'
import { buildOperatorChallenge } from '../src/routes/operator-auth.js'

const NOW = '2026-05-21T00:00:00.000Z'
// Anvil deterministic test keys (well-known, not secret).
const PK_A = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
const PK_B = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const

function appOptions(store: InMemoryGatewayStore): GatewayAppOptions {
  return { store, pepper: 'test-pepper', adminToken: 'admin-secret', baseUrl: 'https://dashboard.mykey.example', now: () => NOW }
}
function seedStore() {
  return new InMemoryGatewayStore({ baseUrl: 'https://api.mykey.example', accounts: [] })
}
type App = ReturnType<typeof createGatewayApp>

async function signedAuth(pk: `0x${string}`, issuedAt = NOW) {
  const account = privateKeyToAccount(pk)
  const address = account.address.toLowerCase()
  const challenge = buildOperatorChallenge(address, issuedAt)
  const sig = await account.signMessage({ message: challenge })
  return { address, challenge, sig }
}

function post(app: App, path: string, body: unknown, session?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (session) headers['x-operator-session'] = session
  return app.fetch(new Request(`https://gateway.test${path}`, { method: 'POST', headers, body: JSON.stringify(body) }))
}
function get(app: App, path: string, session?: string) {
  const headers: Record<string, string> = {}
  if (session) headers['x-operator-session'] = session
  return app.fetch(new Request(`https://gateway.test${path}`, { headers }))
}

test('operator register → session → /operator/me round-trips', async () => {
  const app = createGatewayApp(appOptions(seedStore()))
  const reg = await post(app, '/operator/register', { ...(await signedAuth(PK_A)), display_name: 'Alice' })
  assert.equal(reg.status, 201)
  const { operator_id, session_token } = (await reg.json()) as { operator_id: string; session_token: string }
  assert.ok(operator_id.startsWith('op_'))
  const me = await get(app, '/operator/me', session_token)
  assert.equal(me.status, 200)
  assert.equal(((await me.json()) as { operator_id: string }).operator_id, operator_id)
})

test('register is idempotent per address; login returns the same operator', async () => {
  const app = createGatewayApp(appOptions(seedStore()))
  const reg = await post(app, '/operator/register', await signedAuth(PK_A))
  const id1 = ((await reg.json()) as { operator_id: string }).operator_id
  const login = await post(app, '/operator/login', await signedAuth(PK_A))
  assert.equal(login.status, 200)
  assert.equal(((await login.json()) as { operator_id: string }).operator_id, id1)
})

test('a signature by the wrong key is rejected', async () => {
  const app = createGatewayApp(appOptions(seedStore()))
  const a = await signedAuth(PK_A)
  const sigByB = await privateKeyToAccount(PK_B).signMessage({ message: a.challenge })
  const res = await post(app, '/operator/register', { address: a.address, challenge: a.challenge, sig: sigByB })
  assert.equal(res.status, 401)
})

test('login for an unregistered address is 404', async () => {
  const app = createGatewayApp(appOptions(seedStore()))
  const res = await post(app, '/operator/login', await signedAuth(PK_B))
  assert.equal(res.status, 404)
})

test('a stale challenge (outside the freshness window) is rejected', async () => {
  const app = createGatewayApp(appOptions(seedStore()))
  const stale = await signedAuth(PK_A, '2026-05-20T00:00:00.000Z') // 1 day before NOW
  const res = await post(app, '/operator/register', stale)
  assert.equal(res.status, 401)
})

test('no operator session → /operator/me is 401', async () => {
  const app = createGatewayApp(appOptions(seedStore()))
  assert.equal((await get(app, '/operator/me')).status, 401)
})

test('operators are isolated: each session resolves only to its own operator', async () => {
  const app = createGatewayApp(appOptions(seedStore()))
  const a = (await (await post(app, '/operator/register', await signedAuth(PK_A))).json()) as {
    operator_id: string
    session_token: string
  }
  const b = (await (await post(app, '/operator/register', await signedAuth(PK_B))).json()) as {
    operator_id: string
    session_token: string
  }
  assert.notEqual(a.operator_id, b.operator_id)
  assert.equal(((await (await get(app, '/operator/me', a.session_token)).json()) as { operator_id: string }).operator_id, a.operator_id)
  assert.equal(((await (await get(app, '/operator/me', b.session_token)).json()) as { operator_id: string }).operator_id, b.operator_id)
})
