import { normalizeEvmAddress, tokenToBaseUnitDecimal } from './assetVault'

export type CryptoSpendOption = {
  key: string
  symbol: string
  contract: string | null
  decimals: number
  balance?: string | null
}

export type CryptoValidationResult = {
  ok: boolean
  reason?: string
  amountBaseUnits?: string
  tokenIn?: string
  tokenOut?: string
  slippageBps?: number
}

export type SwapQuoteLike = {
  amountIn: string
  amountOut: string
  amountOutMin: string
  quoteDecimals?: string | null
  estimatedGas?: string | null
  to: string
  calldata: string
  value: string
  router: string
  source: string
}

function invalid(reason: string): CryptoValidationResult {
  return { ok: false, reason }
}

function parsePositiveBaseUnits(value: string, decimals: number, label: string): string | CryptoValidationResult {
  try {
    const baseUnits = tokenToBaseUnitDecimal(value, decimals, label)
    if (BigInt(baseUnits) <= 0n) return invalid('请输入大于 0 的数量。')
    return baseUnits
  } catch {
    return invalid(`${label}格式不正确。`)
  }
}

function exceedsBalance(amountBaseUnits: string, token: CryptoSpendOption): boolean {
  const balance = token.balance?.trim()
  if (!balance) return false
  try {
    return BigInt(amountBaseUnits) > BigInt(tokenToBaseUnitDecimal(balance, token.decimals, '余额'))
  } catch {
    return false
  }
}

function normalizeOptionalToken(contract: string): string | CryptoValidationResult {
  const trimmed = contract.trim()
  if (!trimmed) return 'ETH'
  try {
    return normalizeEvmAddress(trimmed)
  } catch {
    return invalid('买入代币合约地址不是有效 EVM 地址。')
  }
}

function formatBaseUnitAmount(value: string, decimals: number): string {
  try {
    const raw = BigInt(value)
    const base = 10n ** BigInt(decimals)
    const whole = raw / base
    const fraction = (raw % base).toString().padStart(decimals, '0').replace(/0+$/, '')
    if (!fraction) return whole.toString()
    return `${whole}.${fraction.slice(0, 8)}`
  } catch {
    return value
  }
}

export function validateCryptoSend(input: {
  hasAccount: boolean
  canSign: boolean
  hasRpcUrl: boolean
  chainId?: string | null
  token?: CryptoSpendOption | null
  to: string
  amount: string
  unlockRequired: boolean
  unlockSecret?: string
}): CryptoValidationResult {
  if (!input.hasAccount) return invalid('请选择账户。')
  if (!input.canSign) return invalid('观察钱包不能发送交易。')
  if (!input.hasRpcUrl) return invalid('缺少 RPC，请先配置 Alchemy key 或 RPC URL。')
  if (!input.chainId) return invalid('当前链暂不支持发送。')
  if (!input.token) return invalid('当前账户没有可发送的资产。')
  if (!input.to.trim()) return invalid('请输入收款地址。')
  if (!input.amount.trim()) return invalid('请输入数量。')
  try {
    normalizeEvmAddress(input.to)
  } catch {
    return invalid('收款地址不是有效 EVM 地址。')
  }
  const amount = parsePositiveBaseUnits(input.amount.trim(), input.token.decimals, '数量')
  if (typeof amount !== 'string') return amount
  if (exceedsBalance(amount, input.token)) return invalid('余额不足。')
  if (input.unlockRequired && !input.unlockSecret?.trim()) return invalid('请输入钱包解锁密码。')
  return { ok: true, amountBaseUnits: amount }
}

export function validateCryptoSwap(input: {
  hasAccount: boolean
  canSign: boolean
  hasRpcUrl: boolean
  chainId?: string | null
  fromToken?: CryptoSpendOption | null
  toContract: string
  amount: string
  slippageBps: string
}): CryptoValidationResult {
  if (!input.hasAccount) return invalid('请选择账户。')
  if (!input.canSign) return invalid('观察钱包不能交易。')
  if (!input.hasRpcUrl) return invalid('缺少 RPC，请先配置 Alchemy key 或 RPC URL。')
  if (!input.chainId) return invalid('当前链暂不支持 Swap。')
  if (!input.fromToken) return invalid('请选择卖出资产。')
  if (!input.amount.trim()) return invalid('请输入卖出数量。')
  const amount = parsePositiveBaseUnits(input.amount.trim(), input.fromToken.decimals, '卖出数量')
  if (typeof amount !== 'string') return amount
  if (exceedsBalance(amount, input.fromToken)) return invalid('余额不足。')
  const tokenIn = input.fromToken.contract || 'ETH'
  const tokenOut = normalizeOptionalToken(input.toContract)
  if (typeof tokenOut !== 'string') return tokenOut
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) return invalid('不能兑换同一种资产。')
  const slippage = Number(input.slippageBps || '50')
  if (!Number.isInteger(slippage) || slippage < 1 || slippage > 5000) {
    return invalid('滑点必须在 0.01% 到 50% 之间。')
  }
  return { ok: true, amountBaseUnits: amount, tokenIn, tokenOut, slippageBps: slippage }
}

export function formatSwapQuoteSummary(input: {
  quote: SwapQuoteLike
  outputSymbol: string
  outputDecimals: number
  slippageBps: number
}): string {
  const expected = input.quote.quoteDecimals || formatBaseUnitAmount(input.quote.amountOut, input.outputDecimals)
  const minimum = formatBaseUnitAmount(input.quote.amountOutMin, input.outputDecimals)
  const sourceLabel = input.quote.source === 'uniswap-routing-api' ? 'Uniswap 路由 API' : '链上 Uniswap V3'
  const parts = [
    `预计获得 ≈ ${expected} ${input.outputSymbol}`,
    `最少 ${minimum} ${input.outputSymbol}`,
    `滑点 ${(input.slippageBps / 100).toFixed(2)}%`,
    sourceLabel,
    input.quote.router,
  ]
  if (input.quote.estimatedGas) parts.push(`Gas ${input.quote.estimatedGas}`)
  return parts.join(' · ')
}
