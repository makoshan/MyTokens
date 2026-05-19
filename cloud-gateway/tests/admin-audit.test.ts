import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryGatewayStore } from '../src/db/store.js'
import { createGatewayApp } from '../src/index.js'

function seedStore() {
  return new InMemoryGatewayStore({
    baseUrl: 'https://api.mykey.example',
    accounts: [],
  })
}

function appOptions(store: InMemoryGatewayStore, masterKeys?: Record<string, Uint8Array>) {
  return {
    store,
    pepper: 'audit-pepper',
    adminToken: 'admin-secret',
    baseUrl: 'https://dashboard.mykey.example',
    masterKeys,
    now: () => '2026-05-20T00:00:00Z',
  }
}

test('admin mutating routes write one audit entry each with sha256 payload hash and no plaintext leak', async () => {
  const store = seedStore()
  const masterKeys = { v1: new Uint8Array(32).fill(13) }
  const app = createGatewayApp(appOptions(store, masterKeys))

  // 1. Create account
  const createAccount = await app.fetch(
    new Request('https://gateway.test/admin/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'acct-audit', display_name: 'Audit Test', account_group: 'friends' }),
    })
  )
  assert.equal(createAccount.status, 201)

  // 2. Manual credit
  await app.fetch(
    new Request('https://gateway.test/admin/accounts/acct-audit/manual-credit', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ amount_micro_usd: 1_000_000 }),
    })
  )

  // 3. Create invite
  await app.fetch(
    new Request('https://gateway.test/admin/accounts/acct-audit/invites', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
  )

  // 4. Create API key
  const keyResp = await app.fetch(
    new Request('https://gateway.test/admin/accounts/acct-audit/api-keys', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'audit key' }),
    })
  )
  const { id: keyId, raw_key } = (await keyResp.json()) as { id: string; raw_key: string }

  // 5. Revoke API key
  await app.fetch(
    new Request(`https://gateway.test/admin/api-keys/${keyId}/revoke`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret' },
    })
  )

  // 6. Upload provider token with sensitive plaintext
  await app.fetch(
    new Request('https://gateway.test/admin/provider-tokens', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'tok-audit',
        provider: 'openai',
        adapter: 'openai',
        label: 'audit-openai',
        plaintext: 'sk-very-secret-upstream-key',
        models: ['gpt-4.1-mini'],
      }),
    })
  )

  // 7. Price book
  await app.fetch(
    new Request('https://gateway.test/admin/price-book', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'price-audit',
        provider: 'openai',
        model: 'gpt-4.1-mini',
        version: 1,
        sell_input_micro_usd_per_1m_tokens: 100_000,
        sell_output_micro_usd_per_1m_tokens: 200_000,
        upstream_input_micro_usd_per_1m_tokens: 50_000,
        upstream_output_micro_usd_per_1m_tokens: 100_000,
      }),
    })
  )

  // 8. Routing rule
  await app.fetch(
    new Request('https://gateway.test/admin/routing-rules', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'route-audit',
        account_group: 'friends',
        requested_model: 'gpt-4.1-mini',
        provider_token_id: 'tok-audit',
        actual_provider_model: 'gpt-4.1-mini',
        priority: 1,
        weight: 10,
      }),
    })
  )

  // Confirm an audit row per mutating action.
  const expectedActions = [
    'admin.account.create',
    'admin.account.credit',
    'admin.invite.create',
    'admin.api_key.create',
    'admin.api_key.revoke',
    'admin.provider_token.upsert',
    'admin.price_book.upsert',
    'admin.routing_rule.upsert',
  ]
  assert.equal(store.auditLog.length, expectedActions.length)
  assert.deepEqual(store.auditLog.map((row) => row.action), expectedActions)

  for (const row of store.auditLog) {
    if (row.metadata.payload_hash !== null) {
      const hash = row.metadata.payload_hash as string
      assert.equal(typeof hash, 'string')
      assert.match(hash, /^[a-f0-9]{64}$/, `${row.action} payload_hash must be sha256 hex`)
    }
    assert.equal(row.actor, 'admin')
    assert.equal(typeof row.metadata.status_code, 'number')
  }

  // Sensitive plaintexts must never appear in audit metadata.
  const serialized = JSON.stringify(store.auditLog)
  assert.ok(!serialized.includes('sk-very-secret-upstream-key'), 'provider plaintext must not leak to audit metadata')
  assert.ok(!serialized.includes(raw_key), 'buyer raw API key must not leak to audit metadata')
})

test('admin credit-request approve/reject also append audit entries with decision_ok flag', async () => {
  const store = new InMemoryGatewayStore({
    baseUrl: 'https://api.mykey.example',
    accounts: [
      {
        id: 'acct-cr',
        displayName: 'Credit Req Audit',
        status: 'active',
        accountGroup: 'friends',
        balanceMicroUsd: 0,
        reservedMicroUsd: 0,
        defaultProvider: 'openai',
        createdAt: '2026-05-20T00:00:00Z',
        updatedAt: '2026-05-20T00:00:00Z',
      },
    ],
    creditRequests: [
      {
        id: 'crq-1',
        accountId: 'acct-cr',
        requestedMicroUsd: 500_000,
        status: 'pending',
        createdAt: '2026-05-20T00:00:00Z',
      },
      {
        id: 'crq-2',
        accountId: 'acct-cr',
        requestedMicroUsd: 250_000,
        status: 'pending',
        createdAt: '2026-05-20T00:00:00Z',
      },
    ],
  })
  const app = createGatewayApp(appOptions(store))

  await app.fetch(
    new Request('https://gateway.test/admin/credit-requests/crq-1/approve', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret' },
    })
  )
  await app.fetch(
    new Request('https://gateway.test/admin/credit-requests/crq-2/reject', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret' },
    })
  )

  const approveAudit = store.auditLog.find((row) => row.action === 'admin.credit_request.approve')
  const rejectAudit = store.auditLog.find((row) => row.action === 'admin.credit_request.reject')
  assert.ok(approveAudit, 'approve audit entry present')
  assert.ok(rejectAudit, 'reject audit entry present')
  assert.equal(approveAudit.targetId, 'crq-1')
  assert.equal(approveAudit.metadata.decision_ok, true)
  assert.equal(rejectAudit.metadata.decision_ok, true)
})

test('dashboard self-service routes do NOT write admin audit entries', async () => {
  const store = new InMemoryGatewayStore({
    baseUrl: 'https://api.mykey.example',
    accounts: [
      {
        id: 'acct-dash',
        displayName: 'Dashboard User',
        status: 'active',
        accountGroup: 'friends',
        balanceMicroUsd: 0,
        reservedMicroUsd: 0,
        defaultProvider: 'openai',
        createdAt: '2026-05-20T00:00:00Z',
        updatedAt: '2026-05-20T00:00:00Z',
      },
    ],
  })
  const app = createGatewayApp(appOptions(store))

  const inviteResp = await app.fetch(
    new Request('https://gateway.test/admin/accounts/acct-dash/invites', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
  )
  const { invite_token } = (await inviteResp.json()) as { invite_token: string }
  const acceptResp = await app.fetch(
    new Request('https://gateway.test/dashboard/invites/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invite_token }),
    })
  )
  const { session_token } = (await acceptResp.json()) as { session_token: string }

  const auditBefore = store.auditLog.length
  await app.fetch(
    new Request('https://gateway.test/dashboard/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dashboard-session': session_token },
      body: JSON.stringify({}),
    })
  )
  await app.fetch(
    new Request('https://gateway.test/dashboard/credit-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dashboard-session': session_token },
      body: JSON.stringify({ requested_micro_usd: 100_000 }),
    })
  )

  assert.equal(store.auditLog.length, auditBefore, 'dashboard mutations must not write admin audit rows')
})

test('GET /admin/audit-log returns recent entries with actor and action filters', async () => {
  const store = seedStore()
  const app = createGatewayApp(appOptions(store))

  await app.fetch(
    new Request('https://gateway.test/admin/accounts', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'acct-list', display_name: 'List Test' }),
    })
  )

  const resp = await app.fetch(
    new Request('https://gateway.test/admin/audit-log', {
      headers: { authorization: 'Bearer admin-secret' },
    })
  )
  const payload = (await resp.json()) as { data: Array<{ action: string; target_id: string }> }
  assert.equal(resp.status, 200)
  assert.equal(payload.data.length, 1)
  assert.equal(payload.data[0].action, 'admin.account.create')
  assert.equal(payload.data[0].target_id, 'acct-list')

  const unauthorized = await app.fetch(new Request('https://gateway.test/admin/audit-log'))
  assert.equal(unauthorized.status, 401)
})
