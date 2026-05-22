import assert from 'node:assert/strict'
import test from 'node:test'
import { privateKeyToAccount } from 'viem/accounts'
import { createGatewayApp, type GatewayAppOptions, type GatewayEnv } from '../src/index.js'
import { InMemoryGatewayStore } from '../src/db/store.js'
import { buildOperatorChallenge } from '../src/routes/operator-auth.js'

const NOW = '2026-05-22T00:00:00.000Z'
const PAY_TX = `0x${'a'.repeat(64)}` as const
const MYC_TX = `0x${'b'.repeat(64)}` as const
const WITHDRAW_TX = `0x${'d'.repeat(64)}` as const
const SINK = '0xc36fDC5eeee5599aEC0602e36020d4609d07eF3C' // relayer EOA (shared pool)
const WALLET = '0x373f1234567890abcdef1234567890abcdef0d80' // buyer / payout wallet
const USDT = '0x1111111111111111111111111111111111111111'
const FAKE_SIG = `0x${'1'.repeat(130)}` as const
// Anvil deterministic test keys (well-known, not secret) — two distinct operators.
const PK_A = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
const PK_B = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const

const SEPOLIA_ENV: GatewayEnv = { STABLECOIN_TOKEN_ADDRESS: USDT, STABLECOIN_MYC_RATE: '1', TEMPO_CHAIN_ID: '11155111' }

/** Records relayer calls so tests assert on-chain args without a live RPC. */
function stubRelayer() {
  const withdrawCalls: Array<{ tokenAddress: string; to: string; value: bigint }> = []
  return {
    withdrawCalls,
    relayer: {
      address: () => SINK as `0x${string}`,
      transferWithSig: async () => PAY_TX,
      transfer: async () => MYC_TX,
      withdrawToken: async (_env: unknown, input: { tokenAddress: string; to: string; value: bigint }) => {
        withdrawCalls.push({ ...input })
        return WITHDRAW_TX
      },
    } satisfies GatewayAppOptions['relayer'],
  }
}

function appOptions(store: InMemoryGatewayStore, relayer: GatewayAppOptions['relayer']): GatewayAppOptions {
  return { store, pepper: 'test-pepper', adminToken: 'admin-secret', baseUrl: 'https://dashboard.mykey.example', now: () => NOW, relayer }
}

type App = ReturnType<typeof createGatewayApp>

async function signedAuth(pk: `0x${string}`) {
  const account = privateKeyToAccount(pk)
  const address = account.address.toLowerCase()
  const challenge = buildOperatorChallenge(address, NOW)
  const sig = await account.signMessage({ message: challenge })
  return { address, challenge, sig }
}

function opPost(app: App, path: string, body: unknown, session?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (session) headers['x-operator-session'] = session
  return app.fetch(new Request(`https://gateway.test${path}`, { method: 'POST', headers, body: JSON.stringify(body) }), SEPOLIA_ENV)
}
function opGet(app: App, path: string, session?: string) {
  const headers: Record<string, string> = {}
  if (session) headers['x-operator-session'] = session
  return app.fetch(new Request(`https://gateway.test${path}`, { headers }), SEPOLIA_ENV)
}

/** Register an operator and return its session token. */
async function registerOperator(app: App, pk: `0x${string}`): Promise<string> {
  const reg = await opPost(app, '/operator/register', await signedAuth(pk))
  assert.equal(reg.status, 201)
  return ((await reg.json()) as { session_token: string }).session_token
}

/** Create an operator-owned account and open a dashboard session for it. */
async function operatorAccountSession(app: App, opSession: string): Promise<string> {
  const acct = await opPost(app, '/operator/accounts', { display_name: 'Friend', account_group: 'friends' }, opSession)
  const { id } = (await acct.json()) as { id: string }
  const inv = await opPost(app, `/operator/accounts/${id}/invites`, {}, opSession)
  const { invite_token } = (await inv.json()) as { invite_token: string }
  const accept = await app.fetch(
    new Request('https://gateway.test/dashboard/invites/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invite_token }),
    }),
    SEPOLIA_ENV
  )
  return ((await accept.json()) as { session_token: string }).session_token
}

function buyMyc(app: App, dashSession: string, value: string) {
  return app.fetch(
    new Request('https://gateway.test/dashboard/buy-myc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dashboard-session': dashSession },
      body: JSON.stringify({ from: WALLET, value, deadline: '9999999999', sig: FAKE_SIG }),
    }),
    SEPOLIA_ENV
  )
}

test('buy-myc credits the buyer operator treasury; /operator/revenue reports it', async () => {
  const s = stubRelayer()
  const app = createGatewayApp(appOptions(new InMemoryGatewayStore({ baseUrl: 'https://api.mykey.example', accounts: [] }), s.relayer))
  const opSession = await registerOperator(app, PK_A)
  const dash = await operatorAccountSession(app, opSession)

  const buy = await buyMyc(app, dash, '5000000') // $5 USDC
  assert.equal(buy.status, 200)

  const rev = await opGet(app, '/operator/revenue', opSession)
  assert.equal(rev.status, 200)
  const body = (await rev.json()) as {
    treasury: { credited_micro_usd: number; withdrawn_micro_usd: number; withdrawable_micro_usd: number }
    stablecoin: { token_address: string; decimals: number } | null
  }
  assert.equal(body.treasury.credited_micro_usd, 5_000_000)
  assert.equal(body.treasury.withdrawn_micro_usd, 0)
  assert.equal(body.treasury.withdrawable_micro_usd, 5_000_000)
  assert.equal(body.stablecoin?.token_address, USDT)
  assert.equal(body.stablecoin?.decimals, 6)
})

test('withdraw sweeps the withdrawable balance to the operator wallet and decrements it', async () => {
  const s = stubRelayer()
  const app = createGatewayApp(appOptions(new InMemoryGatewayStore({ baseUrl: 'https://api.mykey.example', accounts: [] }), s.relayer))
  const opSession = await registerOperator(app, PK_A)
  const dash = await operatorAccountSession(app, opSession)
  await buyMyc(app, dash, '5000000')

  const wd = await opPost(app, '/operator/treasury/withdraw', { to_address: WALLET }, opSession)
  assert.equal(wd.status, 200)
  const wdBody = (await wd.json()) as { tx_hash: string; withdrawn_micro_usd: number; to_address: string; remaining_withdrawable_micro_usd: number }
  assert.equal(wdBody.tx_hash, WITHDRAW_TX)
  assert.equal(wdBody.withdrawn_micro_usd, 5_000_000)
  assert.equal(wdBody.to_address, WALLET)
  assert.equal(wdBody.remaining_withdrawable_micro_usd, 0)

  // Relayer was asked to move USDC (not MYC) to the operator wallet.
  assert.equal(s.withdrawCalls.length, 1)
  assert.equal(s.withdrawCalls[0].tokenAddress, USDT)
  assert.equal(s.withdrawCalls[0].to, WALLET)
  assert.equal(s.withdrawCalls[0].value, 5_000_000n)

  // Ledger now shows it withdrawn; nothing left to pull.
  const rev = await opGet(app, '/operator/revenue', opSession)
  const body = (await rev.json()) as { treasury: { withdrawn_micro_usd: number; withdrawable_micro_usd: number } }
  assert.equal(body.treasury.withdrawn_micro_usd, 5_000_000)
  assert.equal(body.treasury.withdrawable_micro_usd, 0)
})

test('withdraw rejects an amount over the withdrawable balance without touching the chain', async () => {
  const s = stubRelayer()
  const app = createGatewayApp(appOptions(new InMemoryGatewayStore({ baseUrl: 'https://api.mykey.example', accounts: [] }), s.relayer))
  const opSession = await registerOperator(app, PK_A)
  const dash = await operatorAccountSession(app, opSession)
  await buyMyc(app, dash, '5000000')

  const wd = await opPost(app, '/operator/treasury/withdraw', { to_address: WALLET, amount_micro_usd: 6_000_000 }, opSession)
  assert.equal(wd.status, 400)
  assert.equal(s.withdrawCalls.length, 0)
})

test('withdraw rejects a malformed destination address', async () => {
  const s = stubRelayer()
  const app = createGatewayApp(appOptions(new InMemoryGatewayStore({ baseUrl: 'https://api.mykey.example', accounts: [] }), s.relayer))
  const opSession = await registerOperator(app, PK_A)
  const dash = await operatorAccountSession(app, opSession)
  await buyMyc(app, dash, '5000000')

  const wd = await opPost(app, '/operator/treasury/withdraw', { to_address: '0xnope' }, opSession)
  assert.equal(wd.status, 400)
  assert.equal(s.withdrawCalls.length, 0)
})

test('one operator cannot see or withdraw another operator treasury', async () => {
  const s = stubRelayer()
  const app = createGatewayApp(appOptions(new InMemoryGatewayStore({ baseUrl: 'https://api.mykey.example', accounts: [] }), s.relayer))
  const opA = await registerOperator(app, PK_A)
  const dashA = await operatorAccountSession(app, opA)
  await buyMyc(app, dashA, '5000000') // A's friend pays $5

  const opB = await registerOperator(app, PK_B)
  // B sees zero — A's income is isolated.
  const revB = await opGet(app, '/operator/revenue', opB)
  const bodyB = (await revB.json()) as { treasury: { credited_micro_usd: number; withdrawable_micro_usd: number } }
  assert.equal(bodyB.treasury.credited_micro_usd, 0)
  assert.equal(bodyB.treasury.withdrawable_micro_usd, 0)

  // B cannot pull A's funds out of the shared relayer pool.
  const wdB = await opPost(app, '/operator/treasury/withdraw', { to_address: WALLET }, opB)
  assert.equal(wdB.status, 400)
  assert.equal(s.withdrawCalls.length, 0)
})

test('revenue requires an operator session', async () => {
  const app = createGatewayApp(appOptions(new InMemoryGatewayStore({ baseUrl: 'https://api.mykey.example', accounts: [] }), stubRelayer().relayer))
  const res = await opGet(app, '/operator/revenue')
  assert.equal(res.status, 401)
})
