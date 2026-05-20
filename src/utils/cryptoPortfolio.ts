export type CryptoPortfolioAccount = {
  id: string
  walletId: string
  chain: string
  network: string
  address: string
  derivationPath?: string | null
  createdAt: string
}

export type CryptoPortfolioToken = {
  id: string
  walletId: string
  accountId?: string | null
  chain: string
  network: string
  symbol: string
  contractAddress?: string | null
  decimals?: number | null
  balance?: string | null
  updatedAt: string
}

export type CryptoPortfolioWallet = {
  id: string
  name: string
  walletType: string
  secretKind: string
  createdAt: string
  updatedAt: string
  isActive: boolean
  accounts: CryptoPortfolioAccount[]
  tokens: CryptoPortfolioToken[]
}

export type CryptoChainRow = {
  chain: string
  accountCount: number
  tokenCount: number
  balanceText: string
}

export type CryptoTokenRow = {
  symbol: string
  tokenCount: number
  chainCount: number
  accountCount: number
  balanceText: string
  tokens: CryptoPortfolioToken[]
}

export type CryptoWalletRow = {
  wallet: CryptoPortfolioWallet
  accountCount: number
  tokenCount: number
  chainCount: number
  balanceText: string
}

export type CryptoWalletFormState = {
  name: string
  walletType: string
  secretKind: string
  unlockMode: string
  unlockSecret: string
  address: string
}

export function isWatchOnlyWalletConfig(form: Pick<CryptoWalletFormState, 'walletType' | 'secretKind'>): boolean {
  return form.secretKind === 'watch_only' || form.walletType.toLowerCase().includes('watch')
}

export function canSaveCryptoWalletForm(form: CryptoWalletFormState, savingWallet: boolean): boolean {
  if (savingWallet) return false
  if (isWatchOnlyWalletConfig(form)) return Boolean(form.address.trim())
  if (!form.name.trim()) return false
  return form.unlockMode === 'passkey-prf' || Boolean(form.unlockSecret)
}

export function normalizeWatchOnlyWalletDefaults<T extends CryptoWalletFormState>(form: T): T {
  return {
    ...form,
    walletType: 'hardware-watch',
    secretKind: 'watch_only',
    unlockMode: 'password',
    unlockSecret: '',
  }
}

function sumDecimalText(values: Array<string | null | undefined>): string {
  const nums = values.map((value) => Number(value || 0)).filter((value) => Number.isFinite(value))
  if (!nums.length) return '--'
  const total = nums.reduce((sum, value) => sum + value, 0)
  return Number.isInteger(total) ? String(total) : total.toLocaleString(undefined, { maximumFractionDigits: 8 })
}

export function shortAddress(address?: string | null): string {
  if (!address) return '--'
  if (address.length <= 14) return address
  return `${address.slice(0, 6)}...${address.slice(-5)}`
}

export function getActiveCryptoSelection(
  wallets: CryptoPortfolioWallet[],
  walletId: string | null,
  accountId: string | null
): { wallet: CryptoPortfolioWallet | null; account: CryptoPortfolioAccount | null } {
  const wallet =
    (walletId ? wallets.find((item) => item.id === walletId) : null) ||
    wallets.find((item) => item.accounts.some((account) => account.id === accountId)) ||
    wallets[0] ||
    null
  const account =
    (wallet && accountId ? wallet.accounts.find((item) => item.id === accountId) : null) ||
    wallet?.accounts[0] ||
    null
  return { wallet, account }
}

export function getAccountTokens(
  wallet: CryptoPortfolioWallet | null,
  account: CryptoPortfolioAccount | null
): CryptoPortfolioToken[] {
  if (!wallet || !account) return []
  return wallet.tokens.filter((token) => {
    if (token.accountId) return token.accountId === account.id
    return token.chain === account.chain && token.network === account.network
  })
}

export function buildCryptoPortfolioSummary(wallets: CryptoPortfolioWallet[]) {
  const accountCount = wallets.reduce((sum, wallet) => sum + wallet.accounts.length, 0)
  const chains = new Map<string, { accounts: Set<string>; tokens: CryptoPortfolioToken[] }>()
  const tokens = new Map<string, CryptoPortfolioToken[]>()
  const walletRows: CryptoWalletRow[] = wallets.map((wallet) => ({
    wallet,
    accountCount: wallet.accounts.length,
    tokenCount: wallet.tokens.length,
    chainCount: new Set(wallet.accounts.map((account) => account.chain)).size,
    balanceText: sumDecimalText(wallet.tokens.map((token) => token.balance)),
  }))

  wallets.forEach((wallet) => {
    wallet.accounts.forEach((account) => {
      const row = chains.get(account.chain) || { accounts: new Set<string>(), tokens: [] }
      row.accounts.add(account.id)
      chains.set(account.chain, row)
    })
    wallet.tokens.forEach((token) => {
      const chainRow = chains.get(token.chain) || { accounts: new Set<string>(), tokens: [] }
      if (token.accountId) chainRow.accounts.add(token.accountId)
      chainRow.tokens.push(token)
      chains.set(token.chain, chainRow)

      const symbol = token.symbol.toUpperCase()
      tokens.set(symbol, [...(tokens.get(symbol) || []), token])
    })
  })

  const chainRows: CryptoChainRow[] = [...chains.entries()]
    .map(([chain, row]) => ({
      chain,
      accountCount: row.accounts.size,
      tokenCount: row.tokens.length,
      balanceText: sumDecimalText(row.tokens.map((token) => token.balance)),
    }))
    .sort((a, b) => a.chain.localeCompare(b.chain))

  const tokenRows: CryptoTokenRow[] = [...tokens.entries()]
    .map(([symbol, rowTokens]) => ({
      symbol,
      tokenCount: rowTokens.length,
      chainCount: new Set(rowTokens.map((token) => token.chain)).size,
      accountCount: new Set(rowTokens.map((token) => token.accountId).filter(Boolean)).size,
      balanceText: sumDecimalText(rowTokens.map((token) => token.balance)),
      tokens: rowTokens,
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol))

  return {
    walletCount: wallets.length,
    accountCount,
    chainCount: chainRows.length,
    tokenCount: wallets.reduce((sum, wallet) => sum + wallet.tokens.length, 0),
    balanceText: sumDecimalText(wallets.flatMap((wallet) => wallet.tokens.map((token) => token.balance))),
    walletRows,
    chainRows,
    tokenRows,
  }
}
