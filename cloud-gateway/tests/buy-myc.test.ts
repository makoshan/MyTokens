import assert from 'node:assert/strict'
import test from 'node:test'
import { createGatewayApp, type GatewayAppOptions, type GatewayEnv } from '../src/index.js'
import { InMemoryGatewayStore } from '../src/db/store.js'

const PAY_TX = `0x${'a'.repeat(64)}` as const
const MYC_TX = `0x${'b'.repeat(64)}` as const
const MINT_TX = `0x${'c'.repeat(64)}` as const
const SINK = '0xc36fDC5eeee5599aEC0602e36020d4609d07eF3C' // relayer EOA (payment sink)
const WALLET = '0x373f1234567890abcdef1234567890abcdef0d80' // buyer passkey wallet
const USDT = '0x1111111111111111111111111111111111111111'
const FAKE_SIG = `0x${'1'.repeat(130)}` as const

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

/** Records every relayer call so tests assert on-chain args without a live RPC. */
function stubRelayer() {
  const transferWithSigCalls: Array<{ from: string; to: string; value: bigint; tokenAddress?: string }> = []
  const transferCalls: Array<{ to: string; amountRaw: bigint }> = []
  const mintCalls: Array<{ tokenAddress: string; to: string; value: bigint }> = []
  return {
    transferWithSigCalls,
    transferCalls,
    mintCalls,
    relayer: {
      address: () => SINK as `0x${string}`,
      transferWithSig: async (
        _env: unknown,
        input: { from: string; to: string; value: bigint; deadline: bigint; sig: `0x${string}`; tokenAddress?: string }
      ) => {
        transferWithSigCalls.push({ from: input.from, to: input.to, value: input.value, tokenAddress: input.tokenAddress })
        return PAY_TX
      },
      transfer: async (_env: unknown, to: string, amountRaw: bigint) => {
        transferCalls.push({ to, amountRaw })
        return MYC_TX
      },
      mint: async (_env: unknown, input: { tokenAddress: string; to: string; value: bigint }) => {
        mintCalls.push({ ...input })
        return MINT_TX
      },
    } satisfies GatewayAppOptions['relayer'],
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

const SEPOLIA_ENV: GatewayEnv = { STABLECOIN_TOKEN_ADDRESS: USDT, STABLECOIN_MYC_RATE: '1', TEMPO_CHAIN_ID: '11155111' }

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

function buyMyc(app: App, session: string | null, body: Record<string, unknown>, env: GatewayEnv = SEPOLIA_ENV) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (session) headers['x-dashboard-session'] = session
  return app.fetch(
    new Request('https://gateway.test/dashboard/buy-myc', { method: 'POST', headers, body: JSON.stringify(body) }),
    env
  )
}

function faucet(app: App, session: string | null, body: Record<string, unknown>, env: GatewayEnv = SEPOLIA_ENV) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (session) headers['x-dashboard-session'] = session
  return app.fetch(
    new Request('https://gateway.test/dashboard/faucet-usdt', { method: 'POST', headers, body: JSON.stringify(body) }),
    env
  )
}

test('buy-myc requires a dashboard session', async () => {
  const s = stubRelayer()
  const app = createGatewayApp(appOptions(seedStore(), s.relayer))
  const res = await buyMyc(app, null, { from: WALLET, value: '5000000', deadline: '9999999999', sig: FAKE_SIG })
  assert.equal(res.status, 401)
  assert.equal(s.transferWithSigCalls.length, 0)
})

test('buy-myc pays the relayer in stablecoin, then hands back MYC at 1:1', async () => {
  const s = stubRelayer()
  const app = createGatewayApp(appOptions(seedStore(), s.relayer))
  const session = await openSession(app)
  const res = await buyMyc(app, session, { from: WALLET, value: '5000000', deadline: '9999999999', sig: FAKE_SIG })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { stablecoin_tx_hash: string; tx_hash: string; paid_usdt: number; bought_myc: number; to_address: string }
  assert.equal(body.stablecoin_tx_hash, PAY_TX)
  assert.equal(body.tx_hash, MYC_TX)
  assert.equal(body.paid_usdt, 5)
  assert.equal(body.bought_myc, 5)
  assert.equal(body.to_address, WALLET)

  // 1) USDT pulled from the buyer to the relayer sink, on the stablecoin token.
  assert.equal(s.transferWithSigCalls.length, 1)
  assert.equal(s.transferWithSigCalls[0].from, WALLET)
  assert.equal(s.transferWithSigCalls[0].to, SINK)
  assert.equal(s.transferWithSigCalls[0].value, 5_000_000n)
  assert.equal(s.transferWithSigCalls[0].tokenAddress, USDT)
  // 2) MYC handed back to the buyer at 1:1.
  assert.equal(s.transferCalls.length, 1)
  assert.equal(s.transferCalls[0].to, WALLET)
  assert.equal(s.transferCalls[0].amountRaw, 5_000_000n)
})

test('buy-myc applies a non-1 MYC rate', async () => {
  const s = stubRelayer()
  const app = createGatewayApp(appOptions(seedStore(), s.relayer))
  const session = await openSession(app)
  const res = await buyMyc(
    app,
    session,
    { from: WALLET, value: '5000000', deadline: '9999999999', sig: FAKE_SIG },
    { ...SEPOLIA_ENV, STABLECOIN_MYC_RATE: '2' }
  )
  assert.equal(res.status, 200)
  const body = (await res.json()) as { bought_myc: number }
  assert.equal(body.bought_myc, 10) // 5 USDT × 2 = 10 MYC
  assert.equal(s.transferCalls[0].amountRaw, 10_000_000n)
})

test('buy-myc rejects a non-positive amount before touching the chain', async () => {
  const s = stubRelayer()
  const app = createGatewayApp(appOptions(seedStore(), s.relayer))
  const session = await openSession(app)
  const res = await buyMyc(app, session, { from: WALLET, value: '0', deadline: '9999999999', sig: FAKE_SIG })
  assert.equal(res.status, 400)
  assert.equal(s.transferWithSigCalls.length, 0)
  assert.equal(s.transferCalls.length, 0)
})

test('buy-myc rejects a malformed wallet address', async () => {
  const s = stubRelayer()
  const app = createGatewayApp(appOptions(seedStore(), s.relayer))
  const session = await openSession(app)
  const res = await buyMyc(app, session, { from: '0xnope', value: '5000000', deadline: '9999999999', sig: FAKE_SIG })
  assert.equal(res.status, 400)
  assert.equal(s.transferWithSigCalls.length, 0)
})

test('faucet mints test-USDT to a wallet on testnet', async () => {
  const s = stubRelayer()
  const app = createGatewayApp(appOptions(seedStore(), s.relayer))
  const session = await openSession(app)
  const res = await faucet(app, session, { to_address: WALLET })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { tx_hash: string; minted_usdt: number; to_address: string }
  assert.equal(body.tx_hash, MINT_TX)
  assert.equal(body.minted_usdt, 20) // default 20_000_000 raw
  assert.equal(s.mintCalls.length, 1)
  assert.equal(s.mintCalls[0].tokenAddress, USDT)
  assert.equal(s.mintCalls[0].to, WALLET)
  assert.equal(s.mintCalls[0].value, 20_000_000n)
})

test('faucet is disabled on mainnet (no minting fake USDT in prod)', async () => {
  const s = stubRelayer()
  const app = createGatewayApp(appOptions(seedStore(), s.relayer))
  const session = await openSession(app)
  const res = await faucet(app, session, { to_address: WALLET }, { ...SEPOLIA_ENV, TEMPO_CHAIN_ID: '8453' })
  assert.equal(res.status, 403)
  assert.equal(s.mintCalls.length, 0)
})

test('onchain-config exposes the stablecoin token + relayer sink the wallet must sign to', async () => {
  const s = stubRelayer()
  const app = createGatewayApp(appOptions(seedStore(), s.relayer))
  const session = await openSession(app)
  const res = await app.fetch(
    new Request('https://gateway.test/dashboard/onchain-config', { headers: { 'x-dashboard-session': session } }),
    { ...SEPOLIA_ENV, MYC_TOKEN_ADDRESS: '0x2222222222222222222222222222222222222222' }
  )
  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    chain_id: number
    stablecoin_token: string
    relayer_address: string
    faucet_enabled: boolean
    stablecoin_decimals: number
  }
  assert.equal(body.chain_id, 11155111)
  assert.equal(body.stablecoin_token, USDT)
  assert.equal(body.relayer_address, SINK)
  assert.equal(body.faucet_enabled, true)
  assert.equal(body.stablecoin_decimals, 6)
})

test('onchain-config requires a dashboard session', async () => {
  const app = createGatewayApp(appOptions(seedStore(), stubRelayer().relayer))
  const res = await app.fetch(new Request('https://gateway.test/dashboard/onchain-config'), SEPOLIA_ENV)
  assert.equal(res.status, 401)
})
