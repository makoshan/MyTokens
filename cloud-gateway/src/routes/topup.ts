import { GatewayError } from '../errors.js'
import type { GatewayStore } from '../db/store.js'

// Two burn-with-memo event shapes are recognized (memo carries the buyer
// account ref). We key on these so the memo is available; else fall back to a
// plain burn (Transfer to 0x0).
//   1. MyKeyComputeCredit (our ERC-20, Base/Sepolia/EVM):
//      BurnWithMemo(address indexed from, uint256 value, bytes32 indexed memo)
//      → topics = [sig, from, memo], data = value. memo at index 2.
//   2. Tempo TIP-20 (legacy mainnet deploy):
//      → topics = [sig, from, 0x0, memo], data = value. memo at index 3.
const BURN_TOPICS: Record<string, number> = {
  '0x7bfdc00716ad16b6e8c2ed3acc2167ded8165044051ede67e6bec836bf68d2f4': 2,
  '0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0': 3,
}
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ZERO_TOPIC = '0x0000000000000000000000000000000000000000000000000000000000000000'

export interface TopupConfig {
  rpcUrl: string
  chainId: number
  tokenAddress: string
  /** Micro-USD credited per 1 whole MYC (6-decimal). Default 1 MYC = $1. */
  microUsdPerToken: number
}

export interface VerifiedBurn {
  logIndex: number
  amountRaw: bigint
  /** bytes32 memo from BurnWithMemo, or null for a plain burn. */
  memo: string | null
  fromAddress: string
  creditedMicroUsd: number
}

function topicToAddress(topic: string): string {
  return '0x' + topic.slice(-40)
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[], fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await res.json().catch(() => null)) as { result?: unknown; error?: { message?: string } } | null
  if (!body || body.error) throw new GatewayError('tempo_rpc_error', 502)
  return body.result
}

/**
 * Reads a Tempo tx receipt and verifies it contains a burn of `tokenAddress`.
 * Returns the burn details (amount, memo, sender) so the caller can credit an
 * account. Throws GatewayError on any failure. Read-only — no signing.
 */
export async function verifyBurn(
  config: TopupConfig,
  txHash: string,
  fetchImpl: typeof fetch = fetch
): Promise<VerifiedBurn> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new GatewayError('invalid_tx_hash', 400)
  const receipt = (await rpcCall(config.rpcUrl, 'eth_getTransactionReceipt', [txHash], fetchImpl)) as {
    status?: string
    logs?: Array<{ address: string; topics: string[]; data: string; logIndex: string }>
  } | null
  if (!receipt) throw new GatewayError('tx_not_found', 404)
  if (receipt.status !== '0x1') throw new GatewayError('tx_failed', 400)

  const token = config.tokenAddress.toLowerCase()
  const logs = receipt.logs ?? []

  // Prefer a BurnWithMemo log (carries the buyer account ref); else a plain
  // burn (Transfer to 0x0) on the token.
  let match = logs.find(
    (l) => l.address.toLowerCase() === token && BURN_TOPICS[l.topics[0]?.toLowerCase() ?? ''] !== undefined
  )
  let memo: string | null = null
  if (match) {
    memo = match.topics[BURN_TOPICS[match.topics[0].toLowerCase()]] ?? null
  } else {
    match = logs.find(
      (l) =>
        l.address.toLowerCase() === token &&
        l.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
        l.topics[2]?.toLowerCase() === ZERO_TOPIC
    )
  }
  if (!match) throw new GatewayError('no_burn_in_tx', 400)

  const amountRaw = BigInt(match.data)
  if (amountRaw <= 0n) throw new GatewayError('zero_burn_amount', 400)

  // creditedMicroUsd = (amountRaw / 1e6 MYC) * microUsdPerToken.
  // With microUsdPerToken = 1_000_000 (1 MYC = $1), this is exactly amountRaw.
  const creditedMicroUsd = Number((amountRaw * BigInt(config.microUsdPerToken)) / 1_000_000n)
  if (!Number.isFinite(creditedMicroUsd) || creditedMicroUsd <= 0) {
    throw new GatewayError('credit_amount_invalid', 400)
  }

  return {
    logIndex: Number(BigInt(match.logIndex)),
    amountRaw,
    memo,
    fromAddress: match.topics[1] ? topicToAddress(match.topics[1]) : '0x',
    creditedMicroUsd,
  }
}

/**
 * Full verify-and-credit: checks replay, credits the account, records the topup.
 * Returns the credited amount + the burn details.
 */
export async function verifyAndCreditBurn(input: {
  store: GatewayStore
  config: TopupConfig
  txHash: string
  accountId: string
  now: string
  fetchImpl?: typeof fetch
}): Promise<{ creditedMicroUsd: number; burn: VerifiedBurn; balanceMicroUsd: number }> {
  const burn = await verifyBurn(input.config, input.txHash, input.fetchImpl)
  const consumed = await input.store.isOnchainTopupConsumed({
    chainId: input.config.chainId,
    txHash: input.txHash,
    logIndex: burn.logIndex,
  })
  if (consumed) throw new GatewayError('topup_already_credited', 409)

  const account = await input.store.manualCredit(input.accountId, burn.creditedMicroUsd, input.now)
  await input.store.recordOnchainTopup({
    id: `topup_${crypto.randomUUID()}`,
    chainId: input.config.chainId,
    txHash: input.txHash,
    logIndex: burn.logIndex,
    accountId: input.accountId,
    tokenAddress: input.config.tokenAddress,
    fromAddress: burn.fromAddress,
    toAddress: '0x0000000000000000000000000000000000000000',
    amountRaw: burn.amountRaw.toString(),
    creditedMicroUsd: burn.creditedMicroUsd,
    createdAt: input.now,
  })
  return { creditedMicroUsd: burn.creditedMicroUsd, burn, balanceMicroUsd: account.balanceMicroUsd }
}
