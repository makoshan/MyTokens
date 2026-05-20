// On-chain relayer: the gateway holds a relayer EOA (RELAYER_PRIVATE_KEY) with
// a pool of MYC + ETH. It transfers MYC to friends (red-packet claim) and
// submits gasless burnWithSig txs on their behalf. Ordinary users never mint,
// never pay gas, never hold any privilege — they only sign.
import { createWalletClient, createPublicClient, http, defineChain, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { GatewayError } from '../errors.js'
import type { GatewayEnv } from '../index.js'

const MYC_ABI = [
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'burnWithSig', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes' }], outputs: [] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'nonces', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

function relayerCtx(env?: GatewayEnv) {
  const pk = env?.RELAYER_PRIVATE_KEY
  const token = env?.MYC_TOKEN_ADDRESS
  const rpcUrl = env?.TEMPO_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com'
  const chainId = env?.TEMPO_CHAIN_ID ? Number(env.TEMPO_CHAIN_ID) : 11155111
  if (!pk || !token) throw new GatewayError('relayer_not_configured', 500)
  const chain = defineChain({
    id: chainId,
    name: `evm-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  })
  const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as Hex)
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) })
  const pub = createPublicClient({ chain, transport: http(rpcUrl) })
  return { wallet, pub, account, token: token as Hex }
}

/** Transfer MYC from the relayer pool to a recipient (red-packet claim). Returns the tx hash after confirmation. */
export async function relayerTransfer(env: GatewayEnv | undefined, to: string, amountRaw: bigint): Promise<Hex> {
  const { wallet, pub, account, token } = relayerCtx(env)
  const pool = await pub.readContract({ address: token, abi: MYC_ABI, functionName: 'balanceOf', args: [account.address] })
  if (pool < amountRaw) throw new GatewayError('relayer_pool_insufficient', 503)
  const tx = await wallet.writeContract({ address: token, abi: MYC_ABI, functionName: 'transfer', args: [to as Hex, amountRaw] })
  await pub.waitForTransactionReceipt({ hash: tx, timeout: 120_000 })
  return tx
}

/** Submit a gasless burnWithSig on behalf of `from` (relayer pays gas). Returns the tx hash after confirmation. */
export async function relayerBurnWithSig(
  env: GatewayEnv | undefined,
  input: { from: string; value: bigint; memo: Hex; deadline: bigint; sig: Hex }
): Promise<Hex> {
  const { wallet, pub, token } = relayerCtx(env)
  const tx = await wallet.writeContract({
    address: token,
    abi: MYC_ABI,
    functionName: 'burnWithSig',
    args: [input.from as Hex, input.value, input.memo, input.deadline, input.sig],
  })
  const receipt = await pub.waitForTransactionReceipt({ hash: tx, timeout: 120_000 })
  if (receipt.status !== 'success') throw new GatewayError('burn_tx_failed', 502)
  return tx
}
