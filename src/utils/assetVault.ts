export type AssetKind = 'ai_token' | 'crypto_wallet'

export interface AiAssetSummary {
  kind: 'ai_token'
  id: string
  label: string
  provider: string
  status: 'active' | 'inactive'
}

export interface CryptoAssetSummary {
  kind: 'crypto_wallet'
  id: string
  label: string
  provider: string
  status: 'active' | 'inactive'
  chainCount: number
  tokenCount: number
}

export type AssetSummary = AiAssetSummary | CryptoAssetSummary

export function summarizeAiAssets(
  credentials: Array<{ id: string; name: string; provider: string; is_active: boolean }>
): AiAssetSummary[] {
  return credentials.map((credential) => ({
    kind: 'ai_token',
    id: credential.id,
    label: credential.name,
    provider: credential.provider,
    status: credential.is_active ? 'active' : 'inactive',
  }))
}

export function summarizeCryptoAssets(
  wallets: Array<{
    id: string
    name: string
    walletType: string
    isActive: boolean
    accounts: unknown[]
    tokens: unknown[]
  }>
): CryptoAssetSummary[] {
  return wallets.map((wallet) => ({
    kind: 'crypto_wallet',
    id: wallet.id,
    label: wallet.name,
    provider: wallet.walletType,
    status: wallet.isActive ? 'active' : 'inactive',
    chainCount: wallet.accounts.length,
    tokenCount: wallet.tokens.length,
  }))
}

export function summarizeAssets(
  credentials: Parameters<typeof summarizeAiAssets>[0],
  wallets: Parameters<typeof summarizeCryptoAssets>[0]
): AssetSummary[] {
  return [...summarizeAiAssets(credentials), ...summarizeCryptoAssets(wallets)]
}

export function formatWeiAsEth(weiHexOrDecimal: string): string {
  const raw = weiHexOrDecimal.trim()
  if (!raw) return '0'
  const wei = raw.startsWith('0x') ? BigInt(raw) : BigInt(raw)
  const base = 10n ** 18n
  const whole = wei / base
  const fraction = wei % base
  if (fraction === 0n) return whole.toString()
  const fractionText = fraction.toString().padStart(18, '0').replace(/0+$/, '')
  return `${whole}.${fractionText.slice(0, 8)}`
}

export function ethToWeiDecimal(valueEth: string): string {
  return tokenToBaseUnitDecimal(valueEth, 18, 'ETH amount')
}

export function tokenToBaseUnitDecimal(value: string, decimals: number, label = 'Token amount'): string {
  const normalizedValue = value.trim()
  const decimalPlaces = Number(decimals)
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 36) {
    throw new Error('Token decimals must be an integer between 0 and 36.')
  }
  if (!/^\d+(\.\d+)?$/.test(normalizedValue)) {
    throw new Error(`${label} must be a non-negative decimal number.`)
  }
  const [whole, fraction = ''] = normalizedValue.split('.')
  if (fraction.length > decimalPlaces) {
    throw new Error(`${label} supports up to ${decimalPlaces} decimal places.`)
  }
  const base = 10n ** BigInt(decimalPlaces)
  return (BigInt(whole) * base + BigInt((fraction || '0').padEnd(decimalPlaces, '0') || '0')).toString()
}

export function normalizeEvmAddress(address: string): string {
  const value = address.trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error('EVM address must be 20 bytes hex with 0x prefix.')
  }
  return value
}

export function buildEthTransferInput(input: {
  to: string
  valueEth: string
  nonce: string
  gasLimit: string
  chainId: string
  data?: string
  gasPrice?: string
  maxFeePerGas?: string
  maxPriorityFeePerGas?: string
}) {
  const base = {
    nonce: input.nonce.trim(),
    gasLimit: input.gasLimit.trim(),
    to: normalizeEvmAddress(input.to),
    value: ethToWeiDecimal(input.valueEth),
    chainId: input.chainId.trim(),
    ...(input.data?.trim() ? { data: input.data.trim() } : {}),
  }

  if (input.maxFeePerGas?.trim() || input.maxPriorityFeePerGas?.trim()) {
    return {
      ...base,
      txType: '02',
      maxFeePerGas: input.maxFeePerGas?.trim() || '0',
      maxPriorityFeePerGas: input.maxPriorityFeePerGas?.trim() || '0',
      accessList: [],
    }
  }

  return {
    ...base,
    gasPrice: input.gasPrice?.trim() || '0',
  }
}

export function encodeErc20BalanceOfCall(address: string): string {
  const normalized = normalizeEvmAddress(address).slice(2).toLowerCase()
  return `0x70a08231${normalized.padStart(64, '0')}`
}

export function encodeErc20TransferCall(to: string, amount: string, decimals: number): string {
  const normalizedTo = normalizeEvmAddress(to).slice(2).toLowerCase()
  const amountHex = BigInt(tokenToBaseUnitDecimal(amount, decimals)).toString(16)
  return `0xa9059cbb${normalizedTo.padStart(64, '0')}${amountHex.padStart(64, '0')}`
}

export function buildErc20TransferInput(input: {
  contractAddress: string
  to: string
  amount: string
  decimals: number
  nonce: string
  gasLimit: string
  chainId: string
  gasPrice?: string
  maxFeePerGas?: string
  maxPriorityFeePerGas?: string
}) {
  return buildEthTransferInput({
    to: normalizeEvmAddress(input.contractAddress),
    valueEth: '0',
    nonce: input.nonce,
    gasLimit: input.gasLimit,
    chainId: input.chainId,
    data: encodeErc20TransferCall(input.to, input.amount, input.decimals),
    gasPrice: input.gasPrice,
    maxFeePerGas: input.maxFeePerGas,
    maxPriorityFeePerGas: input.maxPriorityFeePerGas,
  })
}
