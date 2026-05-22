import assert from 'node:assert/strict'
import test from 'node:test'
import { privateKeyToAccount } from 'viem/accounts'
import { createGatewayApp, type GatewayAppOptions } from '../src/index.js'
import { InMemoryGatewayStore } from '../src/db/store.js'
import { buildOperatorChallenge } from '../src/routes/operator-auth.js'

const NOW = '2026-05-21T00:00:00.000Z'
const PK_A = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
const PK_B = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const

function appOptions(store: InMemoryGatewayStore): GatewayAppOptions {
  return {
    store,
    pepper: 'test-pepper',
    adminToken: 'admin-secret',
    masterKeys: { v1: new Uint8Array(32).fill(13) },
    baseUrl: 'https://dashboard.mykey.example',
    now: () => NOW,
  }
}
type App = ReturnType<typeof createGatewayApp>

async function registerOperator(app: App, pk: `0x${string}`): Promise<string> {
  const account = privateKeyToAccount(pk)
  const address = account.address.toLowerCase()
  const challenge = buildOperatorChallenge(address, NOW)
  const sig = await account.signMessage({ message: challenge })
  const res = await app.fetch(
    new Request('https://gateway.test/operator/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address, challenge, sig }),
    })
  )
  return ((await res.json()) as { session_token: string }).session_token
}
function op(app: App, method: string, path: string, session: string, body?: unknown) {
  return app.fetch(
    new Request(`https://gateway.test${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-operator-session': session },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  )
}

test('operator self-serve: provider tokens are isolated per operator', async () => {
  const app = createGatewayApp(appOptions(new InMemoryGatewayStore({ baseUrl: 'x', accounts: [] })))
  const a = await registerOperator(app, PK_A)
  const b = await registerOperator(app, PK_B)

  const created = await op(app, 'POST', '/operator/provider-tokens', a, {
    provider: 'openai',
    label: 'A upstream',
    plaintext: 'sk-a-secret',
    models: ['gpt-4.1-mini'],
  })
  assert.equal(created.status, 201)

  const aList = (await (await op(app, 'GET', '/operator/provider-tokens', a)).json()) as { data: unknown[] }
  assert.equal(aList.data.length, 1)
  const bList = (await (await op(app, 'GET', '/operator/provider-tokens', b)).json()) as { data: unknown[] }
  assert.equal(bList.data.length, 0) // B never sees A's token
})

test('operator self-serve: accounts are isolated and invite/credit enforce ownership', async () => {
  const app = createGatewayApp(appOptions(new InMemoryGatewayStore({ baseUrl: 'x', accounts: [] })))
  const a = await registerOperator(app, PK_A)
  const b = await registerOperator(app, PK_B)

  const acct = (await (await op(app, 'POST', '/operator/accounts', a, { display_name: 'Friend of A' })).json()) as {
    id: string
  }
  assert.ok(acct.id)

  // A sees its own account; B sees none.
  assert.equal(((await (await op(app, 'GET', '/operator/accounts', a)).json()) as { data: unknown[] }).data.length, 1)
  assert.equal(((await (await op(app, 'GET', '/operator/accounts', b)).json()) as { data: unknown[] }).data.length, 0)

  // A can invite + credit its own account.
  assert.equal((await op(app, 'POST', `/operator/accounts/${acct.id}/invites`, a, {})).status, 201)
  const credited = await op(app, 'POST', `/operator/accounts/${acct.id}/manual-credit`, a, { amount_micro_usd: 20_000_000 })
  assert.equal(credited.status, 200)
  assert.equal(((await credited.json()) as { balance_micro_usd: number }).balance_micro_usd, 20_000_000)

  // B cannot touch A's account — 404 (not 403), to avoid leaking existence.
  assert.equal((await op(app, 'POST', `/operator/accounts/${acct.id}/invites`, b, {})).status, 404)
  assert.equal(
    (await op(app, 'POST', `/operator/accounts/${acct.id}/manual-credit`, b, { amount_micro_usd: 1_000_000 })).status,
    404
  )
})

test('operator can list and revoke only its own account invites', async () => {
  const app = createGatewayApp(appOptions(new InMemoryGatewayStore({ baseUrl: 'x', accounts: [] })))
  const a = await registerOperator(app, PK_A)
  const b = await registerOperator(app, PK_B)

  const acctA = (await (await op(app, 'POST', '/operator/accounts', a, { display_name: 'Friend A' })).json()) as {
    id: string
  }
  const acctB = (await (await op(app, 'POST', '/operator/accounts', b, { display_name: 'Friend B' })).json()) as {
    id: string
  }

  const inviteA = (await (await op(app, 'POST', `/operator/accounts/${acctA.id}/invites`, a, {})).json()) as {
    invite_id: string
  }
  await op(app, 'POST', `/operator/accounts/${acctB.id}/invites`, b, {})

  const aList = (await (await op(app, 'GET', '/operator/invites', a)).json()) as {
    data: Array<{ id: string; account_id: string; account_display_name: string; status: string }>
  }
  assert.deepEqual(
    aList.data.map((invite) => ({
      id: invite.id,
      accountId: invite.account_id,
      accountName: invite.account_display_name,
      status: invite.status,
    })),
    [{ id: inviteA.invite_id, accountId: acctA.id, accountName: 'Friend A', status: 'active' }]
  )

  assert.equal((await op(app, 'POST', `/operator/invites/${inviteA.invite_id}/revoke`, b, {})).status, 404)
  const revoked = await op(app, 'POST', `/operator/invites/${inviteA.invite_id}/revoke`, a, {})
  assert.equal(revoked.status, 200)
  assert.equal(((await revoked.json()) as { status: string }).status, 'revoked')

  const revokedList = (await (await op(app, 'GET', '/operator/invites', a)).json()) as {
    data: Array<{ id: string; status: string }>
  }
  assert.deepEqual(revokedList.data.map((invite) => invite.status), ['revoked'])
})

test('operator can grant and edit multiple models for one invited friend', async () => {
  const app = createGatewayApp(appOptions(new InMemoryGatewayStore({ baseUrl: 'x', accounts: [] })))
  const a = await registerOperator(app, PK_A)

  const token = (await (await op(app, 'POST', '/operator/provider-tokens', a, {
    provider: 'bailian',
    adapter: 'openai',
    label: 'BaiLian',
    plaintext: 'sk-bailian',
    models: ['qwen-plus', 'kimi-k2.5', 'gpt-4.1-mini'],
  })).json()) as { id: string }
  for (const model of ['qwen-plus', 'kimi-k2.5', 'gpt-4.1-mini']) {
    assert.equal(
      (await op(app, 'POST', '/operator/routing-rules', a, {
        account_group: 'friends',
        requested_provider: 'bailian',
        requested_model: model,
        provider_token_id: token.id,
        actual_provider_model: model,
      })).status,
      201
    )
  }

  const acct = (await (await op(app, 'POST', '/operator/accounts', a, {
    display_name: 'Multi model friend',
    account_group: 'friends',
    default_model: 'qwen-plus',
    model_allowlist: ['qwen-plus', 'kimi-k2.5'],
  })).json()) as { id: string; model_allowlist: string[] }
  assert.deepEqual(acct.model_allowlist, ['qwen-plus', 'kimi-k2.5'])

  const invite = (await (await op(app, 'POST', `/operator/accounts/${acct.id}/invites`, a, {})).json()) as {
    invite_token: string
  }
  const accepted = await app.fetch(
    new Request('https://gateway.test/dashboard/invites/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invite_token: invite.invite_token }),
    })
  )
  const session = ((await accepted.json()) as { session_token: string }).session_token
  const firstSnapshot = (await (await app.fetch(
    new Request('https://gateway.test/dashboard/me', { headers: { 'x-dashboard-session': session } })
  )).json()) as { routingRules: Array<{ requestedModel: string }> }
  assert.deepEqual(
    firstSnapshot.routingRules.map((rule) => rule.requestedModel).sort(),
    ['kimi-k2.5', 'qwen-plus']
  )

  const updated = await op(app, 'PATCH', `/operator/accounts/${acct.id}`, a, {
    model_allowlist: ['kimi-k2.5'],
    default_model: 'kimi-k2.5',
  })
  assert.equal(updated.status, 200)
  assert.deepEqual(((await updated.json()) as { model_allowlist: string[] }).model_allowlist, ['kimi-k2.5'])

  const secondSnapshot = (await (await app.fetch(
    new Request('https://gateway.test/dashboard/me', { headers: { 'x-dashboard-session': session } })
  )).json()) as { routingRules: Array<{ requestedModel: string }> }
  assert.deepEqual(secondSnapshot.routingRules.map((rule) => rule.requestedModel), ['kimi-k2.5'])
})

// Regression: revoking an invite must cut the *friend* off, not just invalidate
// the link. An already-accepted friend keeps a live dashboard session, so revoke
// has to disable the account — which blocks both the dashboard and all relay.
test('revoking an accepted invite disables the account and cuts off dashboard access', async () => {
  const app = createGatewayApp(appOptions(new InMemoryGatewayStore({ baseUrl: 'x', accounts: [] })))
  const a = await registerOperator(app, PK_A)

  const acct = (await (await op(app, 'POST', '/operator/accounts', a, {
    display_name: 'Soon-cut friend',
    account_group: 'friends',
  })).json()) as { id: string }
  const invite = (await (await op(app, 'POST', `/operator/accounts/${acct.id}/invites`, a, {})).json()) as {
    invite_id: string
    invite_token: string
  }
  const accepted = await app.fetch(
    new Request('https://gateway.test/dashboard/invites/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invite_token: invite.invite_token }),
    })
  )
  const session = ((await accepted.json()) as { session_token: string }).session_token

  // Before revoke: the friend's dashboard works.
  const before = await app.fetch(
    new Request('https://gateway.test/dashboard/me', { headers: { 'x-dashboard-session': session } })
  )
  assert.equal(before.status, 200)

  // Revoke: invite revoked AND the account disabled in one action.
  const revoked = await op(app, 'POST', `/operator/invites/${invite.invite_id}/revoke`, a, {})
  assert.equal(revoked.status, 200)
  const revokedBody = (await revoked.json()) as { status: string; account_status: string }
  assert.equal(revokedBody.status, 'revoked')
  assert.equal(revokedBody.account_status, 'disabled')

  // After revoke: the same live session is now rejected — the friend is cut off.
  const after = await app.fetch(
    new Request('https://gateway.test/dashboard/me', { headers: { 'x-dashboard-session': session } })
  )
  assert.equal(after.status, 403)

  // The operator still sees the account, now marked disabled.
  const accounts = (await (await op(app, 'GET', '/operator/accounts', a)).json()) as {
    data: Array<{ id: string; status: string }>
  }
  assert.equal(accounts.data.find((row) => row.id === acct.id)?.status, 'disabled')
})
