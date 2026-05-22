import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './CryptoWalletManager.css'
import {
  buildErc20TransferInput,
  buildEthTransferInput,
  buildRawCallInput,
  encodeErc20AllowanceCall,
  encodeErc20ApproveCall,
  encodeErc20TransferCall,
  ethToWeiDecimal,
  formatWeiAsEth,
  MAX_UINT256,
} from '../utils/assetVault'
import { qrDataUrl } from '../utils/qrCode'
import {
  ALCHEMY_DOCS_URL,
  ALCHEMY_ETH_MAINNET,
  ALCHEMY_PRESETS,
  buildAlchemyRpcUrl,
  findAlchemyPreset,
  maskAlchemyApiKey,
} from '../utils/alchemyRpc'
import {
  OKLINK_DOCS_URL,
  maskOklinkApiKey,
} from '../utils/oklinkApi'
import {
  formatSwapQuoteSummary,
  validateCryptoSend,
  validateCryptoSwap,
  type CryptoSpendOption,
} from '../utils/cryptoTransactions'
import {
  createTcxKeystore,
  deriveTcxAccounts,
  signTcxTransaction,
  type TcxDerivation,
} from '../utils/tcxWallet'
import { createPasskeyPrfKey, getPasskeyPrfKey } from '../utils/passkeyPrf'
import {
  buildCryptoPortfolioSummary,
  canSaveCryptoWalletForm,
  getAccountTokens,
  getActiveCryptoSelection,
  isWatchOnlyWalletConfig,
  normalizeWatchOnlyWalletDefaults,
  shortAddress,
  type TrustWalletTokenStatusMap,
  withTrustWalletVerifiedTokens,
} from '../utils/cryptoPortfolio'
import {
  isAccountScanFresh,
  loadCryptoWalletCache,
  pruneCryptoWalletCache,
  saveCryptoWalletCache,
  type CryptoWalletCache,
} from '../utils/cryptoWalletCache'

export interface CryptoAccount {
  id: string
  walletId: string
  chain: string
  network: string
  address: string
  derivationPath?: string | null
  createdAt: string
}

export interface CryptoToken {
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

export interface CryptoWallet {
  id: string
  name: string
  walletType: string
  secretKind: string
  passkeyCredentialId?: string | null
  passkeyRpId?: string | null
  passkeyPrfSalt?: string | null
  createdAt: string
  updatedAt: string
  isActive: boolean
  accounts: CryptoAccount[]
  tokens: CryptoToken[]
}

export interface CryptoNft {
  network: string
  chain: string
  chainNetwork: string
  contractAddress: string
  tokenId: string
  tokenType: string
  name: string
  collection?: string | null
  imageUrl?: string | null
  description?: string | null
}

export interface CryptoTransfer {
  network: string
  chain: string
  chainNetwork: string
  hash: string
  blockNum: string
  fromAddress: string
  toAddress?: string | null
  value?: string | null
  asset?: string | null
  category: string
  direction: string
  timestamp?: string | null
}

export interface UniswapQuote {
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

interface TrustWalletTokenAsset {
  verified: boolean
  chain: string
  contractChecksum?: string | null
  infoUrl?: string | null
  logoUrl?: string | null
}

type CryptoMode = 'home' | 'portfolio' | 'advanced' | 'create'
type AssetTab = 'tokens' | 'nfts' | 'predictions' | 'leverage' | 'activity'
type HomeModal = 'send' | 'receive' | 'swap' | null

interface CryptoWalletManagerProps {
  masterPassword: string
  wallets: CryptoWallet[]
  loading: boolean
  onWalletsChanged: (wallets: CryptoWallet[]) => void
  onRefresh: () => Promise<void>
  onError: (message: string) => void
}

const walletTypes = ['tcx-wasm', 'mnemonic', 'private-key', 'hardware-watch']
const secretKinds = ['keystore_json', 'mnemonic', 'private_key', 'watch_only']
const chainOptions = ['ETHEREUM', 'BASE', 'ARBITRUM', 'OPTIMISM', 'POLYGON', 'BITCOIN', 'TRON', 'COSMOS', 'POLKADOT', 'SOLANA']
const unlockModes = ['password', 'passkey-prf']

const defaultDerivationPathByChain: Record<string, string> = {
  ETHEREUM: "m/44'/60'/0'/0/0",
  TRON: "m/44'/195'/0'/0/0",
  BITCOIN: "m/84'/0'/0'/0/0",
  COSMOS: "m/44'/118'/0'/0/0",
  POLKADOT: '//imToken//polkadot/0',
  SOLANA: "m/44'/501'/0'/0'",
}

const chainIdByChain: Record<string, string> = {
  ETHEREUM: '1',
  BASE: '8453',
  ARBITRUM: '42161',
  OPTIMISM: '10',
  POLYGON: '137',
}

const nativeSymbolByChain: Record<string, string> = {
  ETHEREUM: 'ETH',
  BASE: 'ETH',
  ARBITRUM: 'ETH',
  OPTIMISM: 'ETH',
  POLYGON: 'MATIC',
}

const explorerTxBaseByChain: Record<string, string> = {
  ETHEREUM: 'https://etherscan.io/tx/',
  BASE: 'https://basescan.org/tx/',
  ARBITRUM: 'https://arbiscan.io/tx/',
  OPTIMISM: 'https://optimistic.etherscan.io/tx/',
  POLYGON: 'https://polygonscan.com/tx/',
}

// Sentinel address the Uniswap routing API uses for the native coin.
const NATIVE_TOKEN = 'ETH'

// Common swap-target tokens per chain so the Swap "to" picker works out of the box.
type SwapPreset = { symbol: string; address: string; decimals: number }
const swapPresetTokensByChain: Record<string, SwapPreset[]> = {
  ETHEREUM: [
    { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
  ],
  BASE: [
    { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  ],
  ARBITRUM: [
    { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    { symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
    { symbol: 'WETH', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
  ],
  OPTIMISM: [
    { symbol: 'USDC', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
    { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  ],
  POLYGON: [
    { symbol: 'USDC', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
    { symbol: 'USDT', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
    { symbol: 'WETH', address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18 },
  ],
}

const uniswapApiBaseStorageKey = 'mykey.crypto.uniswapApiBase'
const uniswapApiKeyStorageKey = 'mykey.crypto.uniswapApiKey'

// Alchemy network host-prefixes (e.g. "eth-mainnet") matching an account's
// mainnet/testnet scope — the unit the portfolio/NFT/transfers APIs expect.
function alchemyNetworksForAccount(account: { network: string }): string[] {
  const wantTestnet = account.network.trim().toUpperCase() !== 'MAINNET'
  return ALCHEMY_PRESETS.filter((preset) => Boolean(preset.testnet) === wantTestnet).map(
    (preset) => preset.host.split('.')[0]
  )
}

const alchemyApiKeyStorageKey = 'mykey.crypto.alchemyApiKey'
const oklinkApiKeyStorageKey = 'mykey.crypto.oklinkApiKey'

function formatUsd(value?: string | null): string | null {
  if (!value) return null
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  return `$${num.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

const trustWalletChain: Record<string, string> = {
  ETHEREUM: 'ethereum',
  BASE: 'base',
  ARBITRUM: 'arbitrum',
  OPTIMISM: 'optimism',
  POLYGON: 'polygon',
}

const TW_BASE = 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains'

// Ordered logo URL candidates. Trust Wallet is the source of truth; Alchemy is
// only a last-resort image fallback after the token passed Trust Wallet validation.
function buildLogoCandidates(
  chain: string,
  contractChecksum: string | null,
  alchemyLogo: string | null
): string[] {
  const out: string[] = []
  const tw = trustWalletChain[chain]
  if (!contractChecksum) {
    if (tw) out.push(`${TW_BASE}/${tw}/info/logo.png`)
    if (alchemyLogo) out.push(alchemyLogo)
    return out
  }
  if (tw) out.push(`${TW_BASE}/${tw}/assets/${contractChecksum}/logo.png`)
  if (alchemyLogo) out.push(alchemyLogo)
  return out
}

function TokenLogo({ candidates, symbol }: { candidates?: string[]; symbol: string }) {
  const [idx, setIdx] = useState(0)
  const src = candidates && idx < candidates.length ? candidates[idx] : null
  if (!src) {
    return <span className="crypto-token-avatar">{symbol.slice(0, 1)}</span>
  }
  return (
    <img
      className="crypto-token-logo"
      src={src}
      alt={symbol}
      loading="lazy"
      onError={() => setIdx((value) => value + 1)}
    />
  )
}

function buildDerivation(chain: string, network: string, derivationPath: string): TcxDerivation {
  return {
    chain,
    network,
    derivationPath: derivationPath || defaultDerivationPathByChain[chain] || "m/44'/60'/0'/0/0",
    ...(chainIdByChain[chain] ? { chainId: chainIdByChain[chain] } : {}),
    ...(chain === 'BITCOIN' ? { segWit: 'VERSION_0' } : {}),
  }
}

export default function CryptoWalletManager({
  masterPassword,
  wallets,
  loading,
  onWalletsChanged,
  onRefresh,
  onError,
}: CryptoWalletManagerProps) {
  const [cryptoMode, setCryptoMode] = useState<CryptoMode>('home')
  const [assetTab, setAssetTab] = useState<AssetTab>('tokens')
  const [accountSwitcherOpen, setAccountSwitcherOpen] = useState(false)
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(null)
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null)
  const [savingWallet, setSavingWallet] = useState(false)
  const [savingAccount, setSavingAccount] = useState(false)
  const [savingToken, setSavingToken] = useState(false)
  const [queryingBalance, setQueryingBalance] = useState<string | null>(null)
  const [queryingTokenBalance, setQueryingTokenBalance] = useState<string | null>(null)
  const [discoveringAlchemyTokens, setDiscoveringAlchemyTokens] = useState(false)
  const [discoveringOklinkAssets, setDiscoveringOklinkAssets] = useState(false)
  const [scanningAllChains, setScanningAllChains] = useState(false)
  const [scanStatus, setScanStatus] = useState<string | null>(null)
  // Scan-derived display data persists to localStorage and rehydrates on mount,
  // so opening the Crypto view reuses the last snapshot instead of re-querying
  // Alchemy + Trust Wallet every time. cacheRef is the single source the
  // persistence effect keeps in sync. See cryptoWalletCache.
  const cacheRef = useRef<CryptoWalletCache | null>(null)
  if (cacheRef.current === null) cacheRef.current = loadCryptoWalletCache()
  const initialCache = cacheRef.current
  const [valueByToken, setValueByToken] = useState<Record<string, string>>(initialCache.valueByToken)
  const [scanTotalUsd, setScanTotalUsd] = useState<string | null>(null)
  const [logoByToken, setLogoByToken] = useState<Record<string, string[]>>(initialCache.logoByToken)
  const [trustWalletStatusByToken, setTrustWalletStatusByToken] = useState<TrustWalletTokenStatusMap>(
    initialCache.trustWalletStatusByToken
  )
  const [tokenInfoView, setTokenInfoView] = useState<{
    token: CryptoToken
    loading: boolean
    data?: {
      name?: string | null
      symbol?: string | null
      description?: string | null
      website?: string | null
      explorer?: string | null
      source: string
    }
    error?: string
  } | null>(null)
  const [loadingGasDefaults, setLoadingGasDefaults] = useState(false)
  const [broadcastingTx, setBroadcastingTx] = useState(false)
  const [signingTx, setSigningTx] = useState(false)
  const [balanceByAccount, setBalanceByAccount] = useState<Record<string, string>>({})
  const [balanceByToken, setBalanceByToken] = useState<Record<string, string>>({})
  const [broadcastHash, setBroadcastHash] = useState('')
  const [walletUnlockSecret, setWalletUnlockSecret] = useState('')
  const [pendingTxInput, setPendingTxInput] = useState<Record<string, unknown> | null>(null)
  const [walletForm, setWalletForm] = useState({
    name: '',
    walletType: 'tcx-wasm',
    secretKind: 'keystore_json',
    unlockMode: 'password',
    unlockSecret: '',
    secretMaterial: '',
    chain: 'ETHEREUM',
    network: 'MAINNET',
    address: '',
    derivationPath: "m/44'/60'/0'/0/0",
  })
  const [accountForm, setAccountForm] = useState({
    chain: 'ETHEREUM',
    network: 'MAINNET',
    address: '',
    derivationPath: "m/44'/60'/0'/0/0",
  })
  const [tokenForm, setTokenForm] = useState({
    symbol: '',
    contractAddress: '',
    decimals: '18',
    balance: '',
  })
  const [rpcForm, setRpcForm] = useState({
    rpcUrl: '',
    txInputJson: '',
    signedRawTx: '',
  })
  const [alchemyApiKey, setAlchemyApiKey] = useState(() => {
    if (typeof window === 'undefined') return ''
    return window.localStorage.getItem(alchemyApiKeyStorageKey) || ''
  })
  const [selectedAlchemyPresetId, setSelectedAlchemyPresetId] = useState(ALCHEMY_ETH_MAINNET.id)
  const [oklinkApiKey, setOklinkApiKey] = useState(() => {
    if (typeof window === 'undefined') return ''
    return window.localStorage.getItem(oklinkApiKeyStorageKey) || ''
  })
  const [alchemyKeySource, setAlchemyKeySource] = useState('none')
  const [oklinkKeySource, setOklinkKeySource] = useState('none')
  const [walletEnvPath, setWalletEnvPath] = useState('')
  const [savingAlchemyKey, setSavingAlchemyKey] = useState(false)
  const [savingOklinkKey, setSavingOklinkKey] = useState(false)
  const [sendForm, setSendForm] = useState({
    assetMode: 'native',
    tokenContract: '',
    tokenDecimals: '18',
    to: '',
    valueEth: '',
    nonce: '',
    gasLimit: '21000',
    chainId: '1',
    maxFeePerGas: '',
    maxPriorityFeePerGas: '',
    gasPrice: '',
  })

  // --- Home Send / Receive / Swap, NFTs, Activity ---
  const [homeModal, setHomeModal] = useState<HomeModal>(null)
  const [nfts, setNfts] = useState<CryptoNft[]>([])
  const [loadingNfts, setLoadingNfts] = useState(false)
  const [activity, setActivity] = useState<CryptoTransfer[]>([])
  const [loadingActivity, setLoadingActivity] = useState(false)
  const autoScannedRef = useRef<Set<string>>(new Set())
  const trustWalletChecksRef = useRef<Set<string>>(new Set())
  const nftsLoadedForRef = useRef<string | null>(null)
  const activityLoadedForRef = useRef<string | null>(null)
  const [sendModalForm, setSendModalForm] = useState({
    tokenKey: 'native',
    to: '',
    amount: '',
    unlockSecret: '',
  })
  const [sendingTx, setSendingTx] = useState(false)
  const [sendModalStatus, setSendModalStatus] = useState<string | null>(null)
  const [sendModalHash, setSendModalHash] = useState('')
  const [copied, setCopied] = useState(false)
  const [swapForm, setSwapForm] = useState({
    fromTokenKey: 'native',
    toContract: '',
    toSymbol: 'USDC',
    toDecimals: '6',
    amount: '',
    slippageBps: '50',
    unlockSecret: '',
  })
  const [uniswapApiBase, setUniswapApiBase] = useState(() => {
    if (typeof window === 'undefined') return ''
    return window.localStorage.getItem(uniswapApiBaseStorageKey) || ''
  })
  const [uniswapApiKey, setUniswapApiKey] = useState(() => {
    if (typeof window === 'undefined') return ''
    return window.localStorage.getItem(uniswapApiKeyStorageKey) || ''
  })
  const [swapQuote, setSwapQuote] = useState<UniswapQuote | null>(null)
  const [swapQuoteKey, setSwapQuoteKey] = useState('')
  const [swapStatus, setSwapStatus] = useState<string | null>(null)
  const [quotingSwap, setQuotingSwap] = useState(false)
  const [swapping, setSwapping] = useState(false)
  const [swapTxHash, setSwapTxHash] = useState('')

  const visibleWallets = useMemo(
    () => withTrustWalletVerifiedTokens(wallets, trustWalletStatusByToken),
    [trustWalletStatusByToken, wallets]
  )
  const visibleWalletById = useMemo(
    () => new Map(visibleWallets.map((wallet) => [wallet.id, wallet])),
    [visibleWallets]
  )
  const activeSelection = useMemo(
    () => getActiveCryptoSelection(wallets, selectedWalletId, selectedAccountId),
    [selectedAccountId, selectedWalletId, wallets]
  )
  const selectedWallet = activeSelection.wallet
  const primaryAccount = activeSelection.account
  const visibleSelectedWallet = selectedWallet ? visibleWalletById.get(selectedWallet.id) || null : null
  const activeTokens = useMemo(
    () => getAccountTokens(visibleSelectedWallet, primaryAccount),
    [primaryAccount, visibleSelectedWallet]
  )
  const portfolioSummary = useMemo(() => buildCryptoPortfolioSummary(visibleWallets), [visibleWallets])
  // Per-symbol representative logo + total USD value, so the Portfolio token table
  // can show logo & value like the Home token list (sourced from the scan).
  const portfolioSymbolExtras = useMemo(() => {
    const map = new Map<string, { logo?: string[]; valueUsd: number }>()
    for (const wallet of visibleWallets) {
      for (const token of wallet.tokens) {
        const sym = token.symbol.toUpperCase()
        const cur = map.get(sym) ?? { logo: undefined as string[] | undefined, valueUsd: 0 }
        if (!cur.logo && logoByToken[token.id]) cur.logo = logoByToken[token.id]
        const v = Number(valueByToken[token.id] || 0)
        if (Number.isFinite(v)) cur.valueUsd += v
        map.set(sym, cur)
      }
    }
    return map
  }, [visibleWallets, logoByToken, valueByToken])
  const selectedWalletUsesPasskey = selectedWallet?.walletType.includes('passkey-prf') || false
  const walletFormIsWatchOnly = isWatchOnlyWalletConfig(walletForm)
  const selectedTokenCount = activeTokens.length
  const selectedAccountCount = selectedWallet?.accounts.length || 0
  const selectedChainCount = useMemo(() => {
    if (!selectedWallet) return 0
    return new Set(selectedWallet.accounts.map((account) => account.chain)).size
  }, [selectedWallet])
  const trackedBalanceText = useMemo(() => {
    if (!activeTokens.length) return '--'
    const totals = activeTokens
      .map((token) => Number(token.balance || 0))
      .filter((value) => Number.isFinite(value))
    if (totals.length === 0) return '--'
    return totals.reduce((sum, value) => sum + value, 0).toLocaleString()
  }, [activeTokens])
  const activeAccountLabel = useMemo(() => {
    if (!selectedWallet || !primaryAccount) return 'No account'
    const index = selectedWallet.accounts.findIndex((account) => account.id === primaryAccount.id)
    return index >= 0 ? `Account ${index + 1}` : 'Account'
  }, [primaryAccount, selectedWallet])
  const activeAccountCanSign = selectedWallet ? !isWatchOnlyWalletConfig(selectedWallet) : false

  useEffect(() => {
    if (!selectedWallet?.id || selectedWalletId === selectedWallet.id) return
    setSelectedWalletId(selectedWallet.id)
  }, [selectedWallet?.id, selectedWalletId])

  useEffect(() => {
    if (!primaryAccount?.id || selectedAccountId === primaryAccount.id) return
    setSelectedAccountId(primaryAccount.id)
  }, [primaryAccount?.id, selectedAccountId])

  useEffect(() => {
    const liveTokenIds = new Set(wallets.flatMap((wallet) => wallet.tokens.map((token) => token.id)))
    setTrustWalletStatusByToken((prev) => {
      const next: TrustWalletTokenStatusMap = {}
      let changed = false
      for (const [tokenId, status] of Object.entries(prev)) {
        if (liveTokenIds.has(tokenId)) {
          next[tokenId] = status
        } else {
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [wallets])

  // Persist scan-derived display data, pruned to tokens/accounts that still
  // exist, so the next mount rehydrates it without a network round-trip.
  useEffect(() => {
    const cache = cacheRef.current
    if (!cache) return
    // Skip while the wallet list is empty — during the parent's async load this
    // is transient, and pruning against it would wipe the snapshot before the
    // real wallets arrive. The persisted cache stays intact until we have data.
    if (wallets.length === 0) return
    cache.logoByToken = logoByToken
    cache.valueByToken = valueByToken
    cache.trustWalletStatusByToken = trustWalletStatusByToken
    const liveTokenIds = new Set(wallets.flatMap((wallet) => wallet.tokens.map((token) => token.id)))
    const liveAccountIds = new Set(wallets.flatMap((wallet) => wallet.accounts.map((account) => account.id)))
    const pruned = pruneCryptoWalletCache(cache, liveTokenIds, liveAccountIds)
    cacheRef.current = pruned
    saveCryptoWalletCache(pruned)
  }, [logoByToken, valueByToken, trustWalletStatusByToken, wallets])

  // Show the active account's last-scanned portfolio total from cache while a
  // fresh scan (if any) is still in flight.
  useEffect(() => {
    if (!primaryAccount?.id) return
    setScanTotalUsd(cacheRef.current?.totalUsdByAccount[primaryAccount.id] || null)
  }, [primaryAccount?.id])

  useEffect(() => {
    if (!masterPassword) return
    const tokensToCheck = wallets
      .flatMap((wallet) => wallet.tokens)
      .filter((token) => token.contractAddress)
      .filter((token) => !trustWalletStatusByToken[token.id])
      .filter((token) => !trustWalletChecksRef.current.has(token.id))
      .slice(0, 80)
    if (tokensToCheck.length === 0) return

    let cancelled = false
    tokensToCheck.forEach((token) => trustWalletChecksRef.current.add(token.id))
    void (async () => {
      const checked = await Promise.all(
        tokensToCheck.map(async (token) => {
          try {
            const asset = await verifyTrustWalletTokenAsset(token.chain, token.contractAddress || null)
            return { token, asset }
          } catch {
            return { token, asset: { verified: false, chain: token.chain } as TrustWalletTokenAsset }
          } finally {
            trustWalletChecksRef.current.delete(token.id)
          }
        })
      )
      if (cancelled) return
      const nextStatus: TrustWalletTokenStatusMap = {}
      const nextLogos: Record<string, string[]> = {}
      checked.forEach(({ token, asset }) => {
        nextStatus[token.id] = asset.verified ? 'verified' : 'missing'
        if (asset.verified && asset.logoUrl) {
          nextLogos[token.id] = [asset.logoUrl]
        }
      })
      setTrustWalletStatusByToken((prev) => ({ ...prev, ...nextStatus }))
      if (Object.keys(nextLogos).length > 0) {
        setLogoByToken((prev) => ({ ...prev, ...nextLogos }))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [masterPassword, trustWalletStatusByToken, wallets])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const key = alchemyApiKey.trim()
    if (key) {
      window.localStorage.setItem(alchemyApiKeyStorageKey, key)
    } else {
      window.localStorage.removeItem(alchemyApiKeyStorageKey)
    }
  }, [alchemyApiKey])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const key = oklinkApiKey.trim()
    if (key) {
      window.localStorage.setItem(oklinkApiKeyStorageKey, key)
    } else {
      window.localStorage.removeItem(oklinkApiKeyStorageKey)
    }
  }, [oklinkApiKey])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const value = uniswapApiBase.trim()
    if (value) window.localStorage.setItem(uniswapApiBaseStorageKey, value)
    else window.localStorage.removeItem(uniswapApiBaseStorageKey)
  }, [uniswapApiBase])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const value = uniswapApiKey.trim()
    if (value) window.localStorage.setItem(uniswapApiKeyStorageKey, value)
    else window.localStorage.removeItem(uniswapApiKeyStorageKey)
  }, [uniswapApiKey])

  // Load keys from .env (priority) / encrypted vault; fall back to localStorage values.
  useEffect(() => {
    if (!masterPassword) return
    let cancelled = false
    void (async () => {
      try {
        const keys = await invoke<{
          alchemy: string
          oklink: string
          alchemySource: string
          oklinkSource: string
          envPath: string
        }>('get_wallet_api_keys', { masterPassword })
        if (cancelled) return
        setWalletEnvPath(keys.envPath)
        setAlchemyKeySource(keys.alchemySource)
        setOklinkKeySource(keys.oklinkSource)
        if (keys.alchemy) setAlchemyApiKey(keys.alchemy)
        if (keys.oklink) setOklinkApiKey(keys.oklink)
      } catch {
        // Vault locked or keys unset — keep whatever localStorage already provided.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [masterPassword])

  const handleSaveWalletKey = async (name: 'alchemy' | 'oklink') => {
    const value = (name === 'alchemy' ? alchemyApiKey : oklinkApiKey).trim()
    const setSaving = name === 'alchemy' ? setSavingAlchemyKey : setSavingOklinkKey
    try {
      setSaving(true)
      await invoke('set_wallet_api_key', { name, value, masterPassword })
      const keys = await invoke<{ alchemySource: string; oklinkSource: string; envPath: string }>(
        'get_wallet_api_keys',
        { masterPassword }
      )
      setAlchemyKeySource(keys.alchemySource)
      setOklinkKeySource(keys.oklinkSource)
      setWalletEnvPath(keys.envPath)
    } catch (error) {
      onError(`保存 ${name} key 到 Vault 失败: ${String(error)}`)
    } finally {
      setSaving(false)
    }
  }

  const walletKeySourceLabel = (source: string) =>
    source === 'env' ? '.env（优先）' : source === 'vault' ? 'Vault（加密）' : '仅本会话'

  const verifyTrustWalletTokenAsset = async (
    chain: string,
    contractAddress: string | null
  ): Promise<TrustWalletTokenAsset> => {
    return invoke<TrustWalletTokenAsset>('verify_trustwallet_token_asset', {
      chain,
      contractAddress,
      masterPassword,
    })
  }

  const handleUseAlchemyRpc = (presetId = selectedAlchemyPresetId) => {
    try {
      const preset = ALCHEMY_PRESETS.find((item) => item.id === presetId) || ALCHEMY_ETH_MAINNET
      const rpcUrl = buildAlchemyRpcUrl(alchemyApiKey, preset)
      setRpcForm((prev) => ({ ...prev, rpcUrl }))
      setAccountForm((prev) => ({
        ...prev,
        chain: preset.chain,
        network: preset.network,
      }))
      setWalletForm((prev) => ({
        ...prev,
        chain: preset.chain,
        network: preset.network,
      }))
      setSendForm((prev) => ({ ...prev, chainId: preset.chainId }))
    } catch (error) {
      onError(String(error))
    }
  }

  const handleSaveWallet = async () => {
    try {
      setSavingWallet(true)
      let secretMaterial = walletForm.secretMaterial.trim()
      let address = walletForm.address.trim()
      let unlockSecret = walletForm.unlockSecret
      let passkeyCredentialId: string | null = null
      let passkeyRpId: string | null = null
      let passkeyPrfSalt: string | null = null
      const derivation = buildDerivation(walletForm.chain, walletForm.network, walletForm.derivationPath)
      if (walletFormIsWatchOnly) {
        unlockSecret = ''
        secretMaterial = ''
      } else if (walletForm.unlockMode === 'passkey-prf' && !unlockSecret) {
        const passkey = await createPasskeyPrfKey(walletForm.name)
        unlockSecret = passkey.prfKeyHex
        passkeyCredentialId = passkey.credentialId
        passkeyRpId = passkey.rpId || null
        passkeyPrfSalt = passkey.prfSalt
      }
      if (!walletFormIsWatchOnly && walletForm.walletType === 'tcx-wasm' && (!secretMaterial || secretMaterial.split(/\s+/).length >= 12)) {
        const mnemonic = secretMaterial && !secretMaterial.trim().startsWith('{') ? secretMaterial : undefined
        const keystoreJson = await createTcxKeystore({
          unlockMode: walletForm.unlockMode === 'passkey-prf' ? 'passkey-prf' : 'password',
          unlockSecret,
          mnemonic,
          network: walletForm.network,
        })
        const accounts = await deriveTcxAccounts({
          keystoreJson,
          unlockSecret,
          derivations: [derivation],
        })
        secretMaterial = keystoreJson
        address = address || accounts[0]?.address || ''
      }
      if (!walletFormIsWatchOnly && walletForm.walletType === 'tcx-wasm' && secretMaterial.trim().startsWith('{') && !address) {
        const accounts = await deriveTcxAccounts({
          keystoreJson: secretMaterial,
          unlockSecret,
          derivations: [derivation],
        })
        address = accounts[0]?.address || ''
      }
      if (!address) {
        throw new Error('Address is required. Enter one or create a tcx-wasm keystore with an unlock secret.')
      }
      const walletName = walletFormIsWatchOnly && !walletForm.name.trim()
        ? `Watch ${shortAddress(address)}`
        : walletForm.name.trim()
      const wallet = await invoke<CryptoWallet>('add_crypto_wallet', {
        ...walletForm,
        name: walletName,
        walletType: walletFormIsWatchOnly ? 'hardware-watch' : `${walletForm.walletType}:${walletForm.unlockMode}`,
        secretKind: walletFormIsWatchOnly ? 'watch_only' : walletForm.secretKind,
        secretMaterial,
        address,
        derivationPath: derivation.derivationPath || null,
        passkeyCredentialId,
        passkeyRpId,
        passkeyPrfSalt,
        masterPassword,
      })
      const next = [wallet, ...wallets]
      onWalletsChanged(next)
      setSelectedWalletId(wallet.id)
      setSelectedAccountId(wallet.accounts[0]?.id || null)
      setWalletForm((prev) => ({
        ...prev,
        name: '',
        unlockSecret: '',
        secretMaterial: '',
        address: '',
      }))
      setCryptoMode('home')
    } catch (error) {
      onError(`保存钱包失败: ${String(error)}`)
    } finally {
      setSavingWallet(false)
    }
  }

  const handleAddAccount = async () => {
    if (!selectedWallet) return
    try {
      setSavingAccount(true)
      let address = accountForm.address.trim()
      const derivation = buildDerivation(accountForm.chain, accountForm.network, accountForm.derivationPath)
      if (!address) {
        let unlockSecret = walletUnlockSecret
        if (!unlockSecret && selectedWalletUsesPasskey) {
          if (!selectedWallet.passkeyCredentialId || !selectedWallet.passkeyPrfSalt) {
            throw new Error('Wallet is missing passkey metadata.')
          }
          unlockSecret = await getPasskeyPrfKey(
            selectedWallet.passkeyCredentialId,
            selectedWallet.passkeyPrfSalt,
            selectedWallet.passkeyRpId
          )
        }
        if (!unlockSecret) {
          throw new Error('Unlock secret is required to derive an address.')
        }
        const keystoreJson = await invoke<string>('get_crypto_wallet_secret', {
          id: selectedWallet.id,
          masterPassword,
        })
        const accounts = await deriveTcxAccounts({
          keystoreJson,
          unlockSecret,
          derivations: [derivation],
        })
        address = accounts[0]?.address || ''
      }
      if (!address) {
        throw new Error('tcx-wasm did not return an address.')
      }
      await invoke<CryptoAccount>('add_crypto_account', {
        walletId: selectedWallet.id,
        chain: accountForm.chain,
        network: accountForm.network,
        address,
        derivationPath: derivation.derivationPath || null,
        masterPassword,
      })
      setAccountForm((prev) => ({ ...prev, address: '' }))
      await onRefresh()
    } catch (error) {
      onError(`添加网络账户失败: ${String(error)}`)
    } finally {
      setSavingAccount(false)
    }
  }

  const handleQueryBalance = async (account: CryptoAccount) => {
    try {
      setQueryingBalance(account.id)
      const result = await invoke<{ balanceWei: string; balanceEth: string }>('query_crypto_native_balance', {
        rpcUrl: rpcForm.rpcUrl,
        address: account.address,
        masterPassword,
      })
      const balance = result.balanceEth || formatWeiAsEth(result.balanceWei)
      setBalanceByAccount((prev) => ({
        ...prev,
        [account.id]: balance,
      }))
      const wallet = wallets.find((item) => item.id === account.walletId)
      if (wallet) {
        const nativeToken = wallet.tokens.find((token) =>
          (!token.accountId || token.accountId === account.id) &&
          token.chain === account.chain &&
          token.network === account.network &&
          !token.contractAddress
        )
        if (nativeToken) {
          await invoke<CryptoToken>('update_crypto_token_balance', {
            tokenId: nativeToken.id,
            balance,
            masterPassword,
          })
        } else {
          await invoke<CryptoToken>('add_crypto_token', {
            walletId: wallet.id,
            accountId: account.id,
            chain: account.chain,
            network: account.network,
            symbol: nativeSymbolByChain[account.chain] || account.chain,
            contractAddress: null,
            decimals: 18,
            balance,
            masterPassword,
          })
        }
        await onRefresh()
      }
    } catch (error) {
      onError(`查询余额失败: ${String(error)}`)
    } finally {
      setQueryingBalance(null)
    }
  }

  const handleBroadcastTx = async () => {
    try {
      if (selectedWallet && !activeAccountCanSign) {
        throw new Error('Watch-only wallets cannot send transactions.')
      }
      setBroadcastingTx(true)
      setBroadcastHash('')
      const result = await invoke<{ txHash: string }>('broadcast_crypto_raw_transaction', {
        rpcUrl: rpcForm.rpcUrl,
        signedRawTx: rpcForm.signedRawTx,
        masterPassword,
      })
      setBroadcastHash(result.txHash)
      setRpcForm((prev) => ({ ...prev, signedRawTx: '' }))
    } catch (error) {
      onError(`发送交易失败: ${String(error)}`)
    } finally {
      setBroadcastingTx(false)
    }
  }

  const buildPendingTransactionInput = () => {
    if (rpcForm.txInputJson.trim()) {
      return JSON.parse(rpcForm.txInputJson)
    }
    if (sendForm.assetMode === 'erc20') {
      return buildErc20TransferInput({
        contractAddress: sendForm.tokenContract,
        to: sendForm.to,
        amount: sendForm.valueEth,
        decimals: Number(sendForm.tokenDecimals || '18'),
        nonce: sendForm.nonce,
        gasLimit: sendForm.gasLimit,
        chainId: sendForm.chainId,
        gasPrice: sendForm.gasPrice,
        maxFeePerGas: sendForm.maxFeePerGas,
        maxPriorityFeePerGas: sendForm.maxPriorityFeePerGas,
      })
    }
    return buildEthTransferInput(sendForm)
  }

  const handleLoadGasDefaults = async () => {
    if (!primaryAccount) return
    try {
      setLoadingGasDefaults(true)
      const txData =
        sendForm.assetMode === 'erc20' && sendForm.tokenContract && sendForm.to && sendForm.valueEth
          ? encodeErc20TransferCall(sendForm.to, sendForm.valueEth, Number(sendForm.tokenDecimals || '18'))
          : undefined
      const result = await invoke<{
        nonce: string
        gasLimit: string
        gasPrice: string
        maxPriorityFeePerGas?: string | null
      }>('get_crypto_evm_fee_defaults', {
        rpcUrl: rpcForm.rpcUrl,
        fromAddress: primaryAccount.address,
        toAddress: sendForm.assetMode === 'erc20' ? sendForm.tokenContract || null : sendForm.to || null,
        valueWei: sendForm.assetMode === 'erc20' ? '0' : sendForm.valueEth ? ethToWeiDecimal(sendForm.valueEth) : '0',
        data: txData || null,
        masterPassword,
      })
      setSendForm((prev) => ({
        ...prev,
        nonce: result.nonce,
        gasLimit: result.gasLimit || prev.gasLimit,
        gasPrice: result.gasPrice || prev.gasPrice,
        maxFeePerGas: result.gasPrice || prev.maxFeePerGas,
        maxPriorityFeePerGas: result.maxPriorityFeePerGas || prev.maxPriorityFeePerGas,
      }))
    } catch (error) {
      onError(`自动查询 nonce/gas 失败: ${String(error)}`)
    } finally {
      setLoadingGasDefaults(false)
    }
  }

  const handleQueryTokenBalance = async (token: CryptoToken) => {
    if (!primaryAccount || !token.contractAddress) return
    try {
      setQueryingTokenBalance(token.id)
      const result = await invoke<{ balance: string; balanceRaw: string }>('query_crypto_erc20_balance', {
        rpcUrl: rpcForm.rpcUrl,
        contractAddress: token.contractAddress,
        ownerAddress: primaryAccount.address,
        decimals: token.decimals ?? 18,
        masterPassword,
      })
      setBalanceByToken((prev) => ({
        ...prev,
        [token.id]: result.balance || result.balanceRaw,
      }))
      await invoke<CryptoToken>('update_crypto_token_balance', {
        tokenId: token.id,
        balance: result.balance || result.balanceRaw,
        masterPassword,
      })
      await onRefresh()
    } catch (error) {
      onError(`查询 ERC20 余额失败: ${String(error)}`)
    } finally {
      setQueryingTokenBalance(null)
    }
  }

  const handleDiscoverAlchemyTokens = async () => {
    if (!selectedWallet || !primaryAccount) return
    try {
      setDiscoveringAlchemyTokens(true)
      const preset = findAlchemyPreset(primaryAccount.chain, primaryAccount.network)
      const rpcUrl = preset && alchemyApiKey ? buildAlchemyRpcUrl(alchemyApiKey, preset) : rpcForm.rpcUrl
      const result = await invoke<Array<{
        contractAddress: string
        symbol: string
        decimals: number
        balance: string
        balanceRaw: string
      }>>('discover_alchemy_erc20_tokens', {
        rpcUrl,
        ownerAddress: primaryAccount.address,
        masterPassword,
      })
      const existingContracts = new Set(
        selectedWallet.tokens
          .map((token) => token.contractAddress?.toLowerCase())
          .filter(Boolean)
      )
      const nextTokens = result.filter((token) => !existingContracts.has(token.contractAddress.toLowerCase()))
      const verifiedStatus: TrustWalletTokenStatusMap = {}
      const verifiedLogos: Record<string, string[]> = {}
      let addedCount = 0
      let hiddenCount = 0
      for (const token of nextTokens.slice(0, 40)) {
        const asset = await verifyTrustWalletTokenAsset(primaryAccount.chain, token.contractAddress)
        if (!asset.verified) {
          hiddenCount += 1
          continue
        }
        const created = await invoke<CryptoToken>('add_crypto_token', {
          walletId: selectedWallet.id,
          accountId: primaryAccount.id,
          chain: primaryAccount.chain,
          network: primaryAccount.network,
          symbol: token.symbol,
          contractAddress: token.contractAddress,
          decimals: token.decimals,
          balance: token.balance,
          masterPassword,
        })
        verifiedStatus[created.id] = 'verified'
        if (asset.logoUrl) verifiedLogos[created.id] = [asset.logoUrl]
        addedCount += 1
      }
      if (Object.keys(verifiedStatus).length > 0) {
        setTrustWalletStatusByToken((prev) => ({ ...prev, ...verifiedStatus }))
      }
      if (Object.keys(verifiedLogos).length > 0) {
        setLogoByToken((prev) => ({ ...prev, ...verifiedLogos }))
      }
      if (addedCount === 0) {
        onError(
          result.length === 0
            ? 'Alchemy 未发现当前地址的 ERC-20 余额。'
            : hiddenCount > 0
              ? `Alchemy 发现的 Token 没有 TrustWallet logo/info，已过滤 ${hiddenCount} 个。`
              : 'Alchemy 发现的 Token 已经在列表中。'
        )
      }
      await onRefresh()
    } catch (error) {
      onError(`Alchemy 发现资产失败: ${String(error)}`)
    } finally {
      setDiscoveringAlchemyTokens(false)
    }
  }

  const handleDiscoverOklinkAssets = async () => {
    if (!selectedWallet || !primaryAccount) return
    try {
      setDiscoveringOklinkAssets(true)
      const result = await invoke<Array<{
        contractAddress?: string | null
        symbol: string
        balance: string
        valueUsd?: string | null
        priceUsd?: string | null
      }>>('discover_oklink_address_assets', {
        apiKey: oklinkApiKey,
        chainShortName: primaryAccount.chain === 'ETHEREUM' ? 'ETH' : primaryAccount.chain,
        ownerAddress: primaryAccount.address,
        masterPassword,
      })
      const existingKeys = new Set(
        selectedWallet.tokens.map((token) => (token.contractAddress || token.symbol).toLowerCase())
      )
      const nextTokens = result.filter((token) => {
        const key = (token.contractAddress || token.symbol).toLowerCase()
        return !existingKeys.has(key)
      })
      const verifiedStatus: TrustWalletTokenStatusMap = {}
      const verifiedLogos: Record<string, string[]> = {}
      let addedCount = 0
      let hiddenCount = 0
      for (const token of nextTokens.slice(0, 50)) {
        const asset = token.contractAddress
          ? await verifyTrustWalletTokenAsset(primaryAccount.chain, token.contractAddress)
          : null
        if (asset && !asset.verified) {
          hiddenCount += 1
          continue
        }
        const created = await invoke<CryptoToken>('add_crypto_token', {
          walletId: selectedWallet.id,
          accountId: primaryAccount.id,
          chain: primaryAccount.chain,
          network: primaryAccount.network,
          symbol: token.symbol,
          contractAddress: token.contractAddress || null,
          decimals: token.contractAddress ? 18 : null,
          balance: token.balance,
          masterPassword,
        })
        if (token.contractAddress) {
          verifiedStatus[created.id] = 'verified'
          if (asset?.logoUrl) verifiedLogos[created.id] = [asset.logoUrl]
        }
        addedCount += 1
      }
      if (Object.keys(verifiedStatus).length > 0) {
        setTrustWalletStatusByToken((prev) => ({ ...prev, ...verifiedStatus }))
      }
      if (Object.keys(verifiedLogos).length > 0) {
        setLogoByToken((prev) => ({ ...prev, ...verifiedLogos }))
      }
      if (addedCount === 0) {
        onError(
          result.length === 0
            ? 'OKLink 未发现当前地址资产。'
            : hiddenCount > 0
              ? `OKLink 发现的 Token 没有 TrustWallet logo/info，已过滤 ${hiddenCount} 个。`
              : 'OKLink 发现的资产已经在列表中。'
        )
      }
      await onRefresh()
    } catch (error) {
      onError(`OKLink 发现资产失败: ${String(error)}`)
    } finally {
      setDiscoveringOklinkAssets(false)
    }
  }

  const handleShowTokenInfo = async (token: CryptoToken) => {
    setTokenInfoView({ token, loading: true })
    if (!token.contractAddress) {
      setTokenInfoView({
        token,
        loading: false,
        data: {
          name: nativeSymbolByChain[token.chain] || token.symbol,
          symbol: token.symbol,
          description: `${token.chain} 原生代币。`,
          source: 'native',
        },
      })
      return
    }
    try {
      const data = await invoke<{
        name?: string | null
        symbol?: string | null
        description?: string | null
        website?: string | null
        explorer?: string | null
        source: string
      }>('fetch_token_info', {
        chain: token.chain,
        contractAddress: token.contractAddress,
        masterPassword,
      })
      setTokenInfoView({ token, loading: false, data })
    } catch (error) {
      setTokenInfoView({ token, loading: false, error: String(error) })
    }
  }

  const handleScanAllChains = async () => {
    if (!selectedWallet || !primaryAccount) return
    const apiKey = alchemyApiKey.trim()
    if (!apiKey) {
      onError('请先在 Advanced → RPC & Send 里填入 Alchemy API key，再进行全链扫描。')
      setCryptoMode('advanced')
      return
    }
    const address = primaryAccount.address
    const accountId = primaryAccount.id
    const wantTestnet = primaryAccount.network.trim().toUpperCase() !== 'MAINNET'
    // Alchemy network ids are the host prefix, e.g. eth-mainnet.g.alchemy.com -> "eth-mainnet".
    const networks = ALCHEMY_PRESETS
      .filter((preset) => Boolean(preset.testnet) === wantTestnet)
      .map((preset) => preset.host.split('.')[0])

    // Index existing tokens so repeated scans update balances instead of duplicating rows.
    const tokenIndex = new Map<string, string>()
    const tokenKey = (chain: string, network: string, contract: string | null, symbol: string) =>
      `${chain.toUpperCase()}|${network.toUpperCase()}|${(contract || symbol).toLowerCase()}`
    for (const token of selectedWallet.tokens) {
      tokenIndex.set(
        tokenKey(token.chain, token.network, token.contractAddress ?? null, token.symbol),
        token.id
      )
    }

    try {
      setScanningAllChains(true)
      setScanStatus(`查询 ${networks.length} 条链 ...`)
      const portfolio = await invoke<Array<{
        network: string
        chain: string
        chainNetwork: string
        contractAddress: string | null
        symbol: string
        decimals: number
        balance: string
        balanceRaw: string
        priceUsd: string | null
        valueUsd: string | null
        isSpam: boolean
        logo: string | null
        contractChecksum: string | null
        trustWalletVerified: boolean
        trustWalletInfoUrl: string | null
        trustWalletLogoUrl: string | null
      }>>('fetch_alchemy_portfolio_tokens', {
        apiKey,
        ownerAddress: address,
        networks,
        masterPassword,
      })

      const scannedValues: Record<string, string> = {}
      const scannedLogos: Record<string, string[]> = {}
      const verifiedStatus: TrustWalletTokenStatusMap = {}
      const chainsSeen = new Set<string>()
      let totalUsd = 0
      let keptCount = 0
      let hiddenCount = 0
      // Collect a batch instead of writing each token with its own invoke.
      // add_crypto_token / update_crypto_token_balance each authenticate the
      // vault (argon2 KDF); N tokens written serially = N argon2 verifies, which
      // froze the Crypto view after a scan. Batch = one vault auth for all.
      const kept: Array<{ token: (typeof portfolio)[number]; key: string; isNative: boolean }> = []
      const batchItems: Array<{
        tokenId: string | null
        walletId: string
        accountId: string
        chain: string
        network: string
        symbol: string
        contractAddress: string | null
        decimals: number
        balance: string
      }> = []
      for (const token of portfolio) {
        if (token.isSpam || !token.trustWalletVerified) {
          hiddenCount += 1
          continue
        }
        const isNative = !token.contractAddress
        // Keep native symbols consistent with the manual balance path's nativeSymbolByChain.
        const symbol = isNative ? nativeSymbolByChain[token.chain] || token.symbol || 'ETH' : token.symbol
        const network = token.chainNetwork || primaryAccount.network
        const key = tokenKey(token.chain, network, token.contractAddress, symbol)
        kept.push({ token, key, isNative })
        batchItems.push({
          tokenId: tokenIndex.get(key) ?? null,
          walletId: selectedWallet.id,
          accountId,
          chain: token.chain,
          network,
          symbol,
          contractAddress: token.contractAddress,
          decimals: token.decimals,
          balance: token.balance,
        })
      }
      const saved = batchItems.length
        ? await invoke<CryptoToken[]>('upsert_crypto_tokens_batch', {
            items: batchItems,
            masterPassword,
          })
        : []
      saved.forEach((row, index) => {
        const entry = kept[index]
        if (!entry) return
        const { token, key, isNative } = entry
        const tokenId = row.id
        tokenIndex.set(key, tokenId)
        if (token.valueUsd) {
          scannedValues[tokenId] = token.valueUsd
          const value = Number(token.valueUsd)
          if (Number.isFinite(value)) totalUsd += value
        }
        const candidates = token.trustWalletLogoUrl
          ? [token.trustWalletLogoUrl]
          : buildLogoCandidates(token.chain, token.contractChecksum, token.logo)
        if (candidates.length) scannedLogos[tokenId] = candidates
        if (!isNative) verifiedStatus[tokenId] = 'verified'
        keptCount += 1
        chainsSeen.add(token.chain)
      })

      setValueByToken((prev) => ({ ...prev, ...scannedValues }))
      setLogoByToken((prev) => ({ ...prev, ...scannedLogos }))
      if (Object.keys(verifiedStatus).length > 0) {
        setTrustWalletStatusByToken((prev) => ({ ...prev, ...verifiedStatus }))
      }
      const totalText =
        totalUsd > 0
          ? `$${totalUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
          : null
      setScanTotalUsd(totalText)
      // Mark this account scanned (gates the auto-scan freshness check) and cache
      // its total; the logo/value maps persist via the dedicated effect above.
      const cache = cacheRef.current
      if (cache) {
        cache.scannedAtByAccount[accountId] = Date.now()
        cache.totalUsdByAccount[accountId] = totalText || ''
        saveCryptoWalletCache(cache)
      }
      const hiddenSuffix = hiddenCount > 0 ? `（已过滤 ${hiddenCount} 个无 TrustWallet logo/info 的 Token）` : ''
      setScanStatus(
        keptCount === 0
          ? `已扫描 ${networks.length} 条链，未发现有效资产${hiddenSuffix}。`
          : `完成：${chainsSeen.size} 条链，共 ${keptCount} 项${totalText ? ` · 总市值约 ${totalText}` : ''}${hiddenSuffix}。`
      )
      await onRefresh()
    } catch (error) {
      onError(`全链扫描失败: ${String(error)}`)
    } finally {
      setScanningAllChains(false)
    }
  }

  // Pick the Alchemy RPC URL for an account's chain so Send/Balance work without
  // a manual "Use RPC" step; fall back to whatever is typed in Advanced.
  const resolveAccountRpcUrl = (account: CryptoAccount): string => {
    const preset = findAlchemyPreset(account.chain, account.network)
    if (preset && alchemyApiKey.trim()) {
      try {
        return buildAlchemyRpcUrl(alchemyApiKey, preset)
      } catch {
        return rpcForm.rpcUrl
      }
    }
    return rpcForm.rpcUrl
  }

  const resolveUnlockSecret = async (provided: string): Promise<string> => {
    let secret = provided.trim()
    if (!secret && selectedWalletUsesPasskey && selectedWallet?.passkeyCredentialId && selectedWallet?.passkeyPrfSalt) {
      secret = await getPasskeyPrfKey(
        selectedWallet.passkeyCredentialId,
        selectedWallet.passkeyPrfSalt,
        selectedWallet.passkeyRpId
      )
    }
    if (!secret) throw new Error('需要钱包解锁密码。')
    return secret
  }

  // All EVM chains (incl. L2s) are signed by tcx as a single "ETHEREUM" secp256k1
  // tx; the chainId in the tx input distinguishes the network.
  const tcxChainFor = (chain: string): string => (chainIdByChain[chain] ? 'ETHEREUM' : chain)

  // Tokens the active account can spend (held balances + a guaranteed native row).
  const tokenOptions = useMemo<CryptoSpendOption[]>(() => {
    const opts = activeTokens.map((token) => ({
      key: token.id,
      symbol: token.symbol,
      contract: token.contractAddress || null,
      decimals: token.decimals ?? 18,
      balance: balanceByToken[token.id] || token.balance || '',
    }))
    if (primaryAccount && !opts.some((opt) => !opt.contract)) {
      opts.unshift({
        key: 'native',
        symbol: nativeSymbolByChain[primaryAccount.chain] || 'ETH',
        contract: null,
        decimals: 18,
        balance: balanceByAccount[primaryAccount.id] || '',
      })
    }
    return opts
  }, [activeTokens, balanceByToken, balanceByAccount, primaryAccount])
  const sendOpt = tokenOptions.find((item) => item.key === sendModalForm.tokenKey) || tokenOptions[0]
  const swapFromOpt = tokenOptions.find((item) => item.key === swapForm.fromTokenKey) || tokenOptions[0]
  const activeRpcUrl = primaryAccount ? resolveAccountRpcUrl(primaryAccount) : ''
  const activeChainId = primaryAccount ? chainIdByChain[primaryAccount.chain] : undefined
  const sendValidation = validateCryptoSend({
    hasAccount: Boolean(primaryAccount),
    canSign: activeAccountCanSign,
    hasRpcUrl: Boolean(activeRpcUrl),
    chainId: activeChainId,
    token: sendOpt,
    to: sendModalForm.to,
    amount: sendModalForm.amount,
    unlockRequired: !selectedWalletUsesPasskey,
    unlockSecret: sendModalForm.unlockSecret,
  })
  const swapQuoteValidation = validateCryptoSwap({
    hasAccount: Boolean(primaryAccount),
    canSign: activeAccountCanSign,
    hasRpcUrl: Boolean(activeRpcUrl),
    chainId: activeChainId,
    fromToken: swapFromOpt,
    toContract: swapForm.toContract,
    amount: swapForm.amount,
    slippageBps: swapForm.slippageBps,
  })
  const currentSwapQuoteKey = [
    primaryAccount?.id || '',
    activeChainId || '',
    swapForm.fromTokenKey,
    swapQuoteValidation.tokenOut || swapForm.toContract.trim().toLowerCase() || 'ETH',
    swapForm.amount.trim(),
    swapForm.slippageBps || '50',
  ].join('|')
  const hasCurrentSwapQuote = Boolean(swapQuote && swapQuoteKey === currentSwapQuoteKey)

  type FeeDefaults = {
    nonce: string
    gasLimit: string
    gasPrice: string
    maxPriorityFeePerGas?: string | null
  }

  const fetchNfts = async () => {
    if (!primaryAccount || !alchemyApiKey.trim()) return
    try {
      setLoadingNfts(true)
      const result = await invoke<CryptoNft[]>('fetch_alchemy_nfts', {
        apiKey: alchemyApiKey.trim(),
        ownerAddress: primaryAccount.address,
        networks: alchemyNetworksForAccount(primaryAccount),
        masterPassword,
      })
      setNfts(result)
      nftsLoadedForRef.current = primaryAccount.id
    } catch (error) {
      onError(`加载 NFT 失败: ${String(error)}`)
    } finally {
      setLoadingNfts(false)
    }
  }

  const fetchActivity = async () => {
    if (!primaryAccount || !alchemyApiKey.trim()) return
    try {
      setLoadingActivity(true)
      const result = await invoke<CryptoTransfer[]>('fetch_alchemy_transfers', {
        apiKey: alchemyApiKey.trim(),
        ownerAddress: primaryAccount.address,
        networks: alchemyNetworksForAccount(primaryAccount),
        masterPassword,
      })
      setActivity(result)
      activityLoadedForRef.current = primaryAccount.id
    } catch (error) {
      onError(`加载交易历史失败: ${String(error)}`)
    } finally {
      setLoadingActivity(false)
    }
  }

  const handleHomeSend = async () => {
    if (!selectedWallet || !primaryAccount) return
    if (!sendValidation.ok) {
      onError(sendValidation.reason || '发送信息不完整。')
      return
    }
    const opt = sendOpt
    if (!opt) {
      onError('当前账户没有可发送的资产。')
      return
    }
    const to = sendModalForm.to.trim()
    const amount = sendModalForm.amount.trim()
    const rpcUrl = activeRpcUrl
    const chainId = activeChainId as string
    try {
      setSendingTx(true)
      setSendModalHash('')
      setSendModalStatus('估算手续费 ...')
      const isErc20 = Boolean(opt.contract)
      const data = isErc20 ? encodeErc20TransferCall(to, amount, opt.decimals) : undefined
      const fee = await invoke<FeeDefaults>('get_crypto_evm_fee_defaults', {
        rpcUrl,
        fromAddress: primaryAccount.address,
        toAddress: isErc20 ? opt.contract : to,
        valueWei: isErc20 ? '0' : ethToWeiDecimal(amount),
        data: data || null,
        masterPassword,
      })
      const txInput = isErc20
        ? buildErc20TransferInput({
            contractAddress: opt.contract as string,
            to,
            amount,
            decimals: opt.decimals,
            nonce: fee.nonce,
            gasLimit: fee.gasLimit,
            chainId,
            maxFeePerGas: fee.gasPrice,
            maxPriorityFeePerGas: fee.maxPriorityFeePerGas || '',
          })
        : buildEthTransferInput({
            to,
            valueEth: amount,
            nonce: fee.nonce,
            gasLimit: fee.gasLimit,
            chainId,
            maxFeePerGas: fee.gasPrice,
            maxPriorityFeePerGas: fee.maxPriorityFeePerGas || '',
          })
      setSendModalStatus('本地签名 ...')
      const unlockSecret = await resolveUnlockSecret(sendModalForm.unlockSecret)
      const keystoreJson = await invoke<string>('get_crypto_wallet_secret', {
        id: selectedWallet.id,
        masterPassword,
      })
      const signed = await signTcxTransaction({
        keystoreJson,
        unlockSecret,
        chain: tcxChainFor(primaryAccount.chain),
        derivationPath: primaryAccount.derivationPath || defaultDerivationPathByChain[primaryAccount.chain],
        txInput,
      })
      const rawTx = typeof signed.signature === 'string' ? signed.signature : ''
      if (!rawTx) throw new Error('tcx-wasm 未返回签名交易。')
      setSendModalStatus('广播交易 ...')
      const result = await invoke<{ txHash: string }>('broadcast_crypto_raw_transaction', {
        rpcUrl,
        signedRawTx: rawTx,
        masterPassword,
      })
      setSendModalHash(result.txHash)
      setSendModalStatus('已广播 ✓')
      setSendModalForm((prev) => ({ ...prev, amount: '', to: '', unlockSecret: '' }))
      await onRefresh()
    } catch (error) {
      setSendModalStatus(null)
      onError(`发送失败: ${String(error)}`)
    } finally {
      setSendingTx(false)
    }
  }

  const handleSwapQuote = async () => {
    if (!primaryAccount) return
    if (!swapQuoteValidation.ok) {
      onError(swapQuoteValidation.reason || 'Swap 信息不完整。')
      return
    }
    const chainId = activeChainId as string
    const tokenIn = swapQuoteValidation.tokenIn || NATIVE_TOKEN
    const tokenOut = swapQuoteValidation.tokenOut || NATIVE_TOKEN
    try {
      setQuotingSwap(true)
      setSwapQuote(null)
      setSwapQuoteKey('')
      setSwapStatus('Uniswap 询价中 ...')
      const amountIn = swapQuoteValidation.amountBaseUnits as string
      const quote = await invoke<UniswapQuote>('uniswap_swap_quote', {
        rpcUrl: activeRpcUrl,
        chainId,
        tokenIn,
        tokenOut,
        amountIn,
        recipient: primaryAccount.address,
        slippageBps: swapQuoteValidation.slippageBps,
        apiBase: uniswapApiBase.trim() || null,
        apiKey: uniswapApiKey.trim() || null,
        masterPassword,
      })
      setSwapQuote(quote)
      setSwapQuoteKey(currentSwapQuoteKey)
      const outSymbol =
        tokenOut === NATIVE_TOKEN
          ? nativeSymbolByChain[primaryAccount.chain] || 'ETH'
          : swapForm.toSymbol || 'TOKEN'
      setSwapStatus(formatSwapQuoteSummary({
        quote,
        outputSymbol: outSymbol,
        outputDecimals: Number(swapForm.toDecimals || '18'),
        slippageBps: swapQuoteValidation.slippageBps || 50,
      }))
    } catch (error) {
      setSwapStatus(null)
      onError(`Uniswap 询价失败: ${String(error)}`)
    } finally {
      setQuotingSwap(false)
    }
  }

  const handleSwap = async () => {
    if (!selectedWallet || !primaryAccount || !swapQuote) return
    if (!swapQuoteValidation.ok) {
      onError(swapQuoteValidation.reason || 'Swap 信息不完整。')
      return
    }
    if (!hasCurrentSwapQuote) {
      onError('报价已过期，请重新获取报价。')
      return
    }
    const chainId = activeChainId as string
    const fromOpt = swapFromOpt
    const rpcUrl = activeRpcUrl
    if (!fromOpt) return
    const derivationPath = primaryAccount.derivationPath || defaultDerivationPathByChain[primaryAccount.chain]
    try {
      setSwapping(true)
      setSwapTxHash('')
      const unlockSecret = await resolveUnlockSecret(swapForm.unlockSecret)
      const keystoreJson = await invoke<string>('get_crypto_wallet_secret', {
        id: selectedWallet.id,
        masterPassword,
      })

      // ERC-20 input needs router allowance; broadcast an approve first if short.
      if (fromOpt.contract) {
        setSwapStatus('检查授权额度 ...')
        const allowanceHex = await invoke<string>('crypto_evm_call', {
          rpcUrl,
          to: fromOpt.contract,
          data: encodeErc20AllowanceCall(primaryAccount.address, swapQuote.to),
          masterPassword,
        })
        const allowance = BigInt(allowanceHex && allowanceHex !== '0x' ? allowanceHex : '0x0')
        if (allowance < BigInt(swapQuote.amountIn)) {
          setSwapStatus('发送授权交易（approve）...')
          const approveData = encodeErc20ApproveCall(swapQuote.to, MAX_UINT256)
          const fee = await invoke<FeeDefaults>('get_crypto_evm_fee_defaults', {
            rpcUrl,
            fromAddress: primaryAccount.address,
            toAddress: fromOpt.contract,
            valueWei: '0',
            data: approveData,
            masterPassword,
          })
          const approveInput = buildRawCallInput({
            to: fromOpt.contract,
            valueWei: '0',
            data: approveData,
            nonce: fee.nonce,
            gasLimit: fee.gasLimit,
            chainId,
            maxFeePerGas: fee.gasPrice,
            maxPriorityFeePerGas: fee.maxPriorityFeePerGas || '',
          })
          const approveSigned = await signTcxTransaction({
            keystoreJson,
            unlockSecret,
            chain: tcxChainFor(primaryAccount.chain),
            derivationPath,
            txInput: approveInput,
          })
          const approveRaw = typeof approveSigned.signature === 'string' ? approveSigned.signature : ''
          if (!approveRaw) throw new Error('approve 签名失败。')
          const approveRes = await invoke<{ txHash: string }>('broadcast_crypto_raw_transaction', {
            rpcUrl,
            signedRawTx: approveRaw,
            masterPassword,
          })
          setSwapStatus(`授权已广播（${shortAddress(approveRes.txHash)}）。等待确认后再次点击 Swap。`)
          setSwapping(false)
          return
        }
      }

      setSwapStatus('构造并签名 Swap ...')
      const fee = await invoke<FeeDefaults>('get_crypto_evm_fee_defaults', {
        rpcUrl,
        fromAddress: primaryAccount.address,
        toAddress: swapQuote.to,
        valueWei: swapQuote.value || '0',
        data: swapQuote.calldata,
        masterPassword,
      })
      const swapInput = buildRawCallInput({
        to: swapQuote.to,
        valueWei: swapQuote.value || '0',
        data: swapQuote.calldata,
        nonce: fee.nonce,
        gasLimit: fee.gasLimit,
        chainId,
        maxFeePerGas: fee.gasPrice,
        maxPriorityFeePerGas: fee.maxPriorityFeePerGas || '',
      })
      const signed = await signTcxTransaction({
        keystoreJson,
        unlockSecret,
        chain: tcxChainFor(primaryAccount.chain),
        derivationPath,
        txInput: swapInput,
      })
      const rawTx = typeof signed.signature === 'string' ? signed.signature : ''
      if (!rawTx) throw new Error('Swap 签名失败。')
      setSwapStatus('广播 Swap ...')
      const result = await invoke<{ txHash: string }>('broadcast_crypto_raw_transaction', {
        rpcUrl,
        signedRawTx: rawTx,
        masterPassword,
      })
      setSwapTxHash(result.txHash)
      setSwapStatus('Swap 已广播 ✓')
      setSwapQuote(null)
      setSwapQuoteKey('')
      setSwapForm((prev) => ({ ...prev, amount: '', unlockSecret: '' }))
      await onRefresh()
    } catch (error) {
      setSwapStatus(null)
      onError(`Swap 失败: ${String(error)}`)
    } finally {
      setSwapping(false)
    }
  }

  // Auto-scan all chains the first time an account is selected, and keep the
  // Advanced RPC URL in sync — so balances appear without any manual click.
  useEffect(() => {
    if (!primaryAccount || !selectedWallet) return
    if (!alchemyApiKey.trim()) return
    const rpcUrl = resolveAccountRpcUrl(primaryAccount)
    if (rpcUrl && rpcUrl !== rpcForm.rpcUrl) {
      setRpcForm((prev) => ({ ...prev, rpcUrl }))
    }
    if (autoScannedRef.current.has(primaryAccount.id)) return
    autoScannedRef.current.add(primaryAccount.id)
    setNfts([])
    setActivity([])
    nftsLoadedForRef.current = null
    activityLoadedForRef.current = null
    // Skip the network scan when this account was scanned recently — the
    // rehydrated cache already renders logos, values and the total. Manual
    // Refresh always rescans, and the cache expires after CRYPTO_SCAN_TTL_MS.
    if (cacheRef.current && isAccountScanFresh(cacheRef.current, primaryAccount.id)) return
    void handleScanAllChains()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryAccount?.id, selectedWallet?.id, alchemyApiKey])

  // Lazily load NFTs / Activity the first time their tab is opened per account.
  useEffect(() => {
    if (cryptoMode !== 'home' || !primaryAccount || !alchemyApiKey.trim()) return
    if (assetTab === 'nfts' && nftsLoadedForRef.current !== primaryAccount.id && !loadingNfts) {
      void fetchNfts()
    }
    if (assetTab === 'activity' && activityLoadedForRef.current !== primaryAccount.id && !loadingActivity) {
      void fetchActivity()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetTab, primaryAccount?.id, cryptoMode, alchemyApiKey])

  const handleCopyAddress = async () => {
    if (!primaryAccount) return
    try {
      await navigator.clipboard.writeText(primaryAccount.address)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      onError('复制失败，请手动复制地址。')
    }
  }

  const handlePrepareTx = () => {
    try {
      if (!activeAccountCanSign) {
        throw new Error('Watch-only wallets can observe balances only.')
      }
      setPendingTxInput(buildPendingTransactionInput())
    } catch (error) {
      onError(`构造交易失败: ${String(error)}`)
    }
  }

  const handleSignTx = async () => {
    if (!selectedWallet || !primaryAccount) return
    try {
      if (!activeAccountCanSign) {
        throw new Error('Watch-only wallets cannot sign transactions.')
      }
      setSigningTx(true)
      let unlockSecret = walletUnlockSecret
      if (!unlockSecret && selectedWalletUsesPasskey) {
        if (!selectedWallet.passkeyCredentialId || !selectedWallet.passkeyPrfSalt) {
          throw new Error('Wallet is missing passkey metadata.')
        }
        unlockSecret = await getPasskeyPrfKey(
          selectedWallet.passkeyCredentialId,
          selectedWallet.passkeyPrfSalt,
          selectedWallet.passkeyRpId
        )
      }
      if (!unlockSecret) {
        throw new Error('Unlock secret is required to sign.')
      }
      const txInput = pendingTxInput || buildPendingTransactionInput()
      const keystoreJson = await invoke<string>('get_crypto_wallet_secret', {
        id: selectedWallet.id,
        masterPassword,
      })
      const signed = await signTcxTransaction({
        keystoreJson,
        unlockSecret,
        chain: primaryAccount.chain,
        derivationPath: primaryAccount.derivationPath || defaultDerivationPathByChain[primaryAccount.chain],
        txInput,
      })
      const rawTx = typeof signed.signature === 'string' ? signed.signature : ''
      if (!rawTx) {
        throw new Error('tcx-wasm did not return a signature/raw transaction.')
      }
      setRpcForm((prev) => ({ ...prev, signedRawTx: rawTx }))
      if (typeof signed.txHash === 'string') {
        setBroadcastHash(signed.txHash)
      }
      setPendingTxInput(null)
    } catch (error) {
      onError(`签名交易失败: ${String(error)}`)
    } finally {
      setSigningTx(false)
    }
  }

  const handleAddToken = async () => {
    if (!selectedWallet || !primaryAccount) return
    try {
      setSavingToken(true)
      const contractAddress = tokenForm.contractAddress.trim()
      const asset = contractAddress
        ? await verifyTrustWalletTokenAsset(primaryAccount.chain, contractAddress)
        : null
      if (asset && !asset.verified) {
        throw new Error('未在 TrustWallet assets 找到该 Token 的 logo/info，已阻止添加。')
      }
      const created = await invoke<CryptoToken>('add_crypto_token', {
        walletId: selectedWallet.id,
        accountId: primaryAccount.id,
        chain: primaryAccount.chain,
        network: primaryAccount.network,
        symbol: tokenForm.symbol,
        contractAddress: contractAddress || null,
        decimals: tokenForm.decimals ? Number(tokenForm.decimals) : null,
        balance: tokenForm.balance || null,
        masterPassword,
      })
      if (asset?.verified) {
        setTrustWalletStatusByToken((prev) => ({ ...prev, [created.id]: 'verified' }))
        if (asset.logoUrl) {
          setLogoByToken((prev) => ({ ...prev, [created.id]: [asset.logoUrl as string] }))
        }
      }
      setTokenForm({ symbol: '', contractAddress: '', decimals: '18', balance: '' })
      await onRefresh()
    } catch (error) {
      onError(`添加 Token 失败: ${String(error)}`)
    } finally {
      setSavingToken(false)
    }
  }

  const handleUseTokenForSend = (token: CryptoToken) => {
    setSendForm((prev) => ({
      ...prev,
      assetMode: token.contractAddress ? 'erc20' : 'native',
      tokenContract: token.contractAddress || '',
      tokenDecimals: String(token.decimals ?? 18),
      chainId: chainIdByChain[token.chain] || prev.chainId,
    }))
    setSendModalStatus(null)
    setSendModalHash('')
    setSendModalForm((prev) => ({
      ...prev,
      tokenKey: token.id,
      to: '',
      amount: '',
    }))
    setCryptoMode('home')
    setHomeModal('send')
  }

  const handleUseWatchOnlyTemplate = () => {
    setWalletForm((prev) => ({
      ...normalizeWatchOnlyWalletDefaults(prev),
      secretMaterial: '',
    }))
  }

  const handleDeleteWallet = async (wallet: CryptoWallet) => {
    if (!confirm(`确定删除钱包 ${wallet.name} 吗？本地保存的加密材料也会删除。`)) return
    try {
      await invoke('delete_crypto_wallet', { id: wallet.id, masterPassword })
      const next = wallets.filter((item) => item.id !== wallet.id)
      onWalletsChanged(next)
      setSelectedWalletId(next[0]?.id || null)
    } catch (error) {
      onError(`删除钱包失败: ${String(error)}`)
    }
  }

  const createWalletSection = (
    <section className="crypto-import-card crypto-create-page">
      <div className="crypto-create-header">
        <button className="crypto-mini-action" onClick={() => setCryptoMode('portfolio')}>
          Back
        </button>
        <div>
          <div className="crypto-eyebrow">MYKEY WALLET</div>
          <h2>Create / Import Wallet</h2>
          <p>Password or passkey PRF unlock metadata stays attached to the local vault.</p>
        </div>
      </div>
      <div className="crypto-watch-callout">
        <div>
          <strong>观察钱包</strong>
          <span>只输入公开地址即可导入；MyKey 不保存私钥，导入后可用 RPC / Explorer 查询余额。</span>
        </div>
        <button className="crypto-action" onClick={handleUseWatchOnlyTemplate}>
          切换到观察导入
        </button>
      </div>
      <div className="crypto-form">
        <input
          value={walletForm.name}
          onChange={(event) => setWalletForm((prev) => ({ ...prev, name: event.target.value }))}
          placeholder={walletFormIsWatchOnly ? 'Wallet name, optional' : 'Wallet name'}
        />
        <div className="crypto-form-row">
          <select
            value={walletForm.walletType}
            onChange={(event) => setWalletForm((prev) => ({ ...prev, walletType: event.target.value }))}
          >
            {walletTypes.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <select
            value={walletForm.secretKind}
            onChange={(event) => setWalletForm((prev) => ({ ...prev, secretKind: event.target.value }))}
          >
            {secretKinds.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
        <select
          value={walletForm.unlockMode}
          onChange={(event) => setWalletForm((prev) => ({ ...prev, unlockMode: event.target.value }))}
        >
          {unlockModes.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <input
          value={walletForm.unlockSecret}
          onChange={(event) => setWalletForm((prev) => ({ ...prev, unlockSecret: event.target.value }))}
          placeholder={walletFormIsWatchOnly ? 'Watch-only does not need a wallet password' : walletForm.unlockMode === 'passkey-prf' ? 'Leave empty to create passkey' : 'Wallet password'}
          disabled={walletFormIsWatchOnly || walletForm.unlockMode === 'passkey-prf'}
          type="password"
        />
        <textarea
          value={walletForm.secretMaterial}
          onChange={(event) => setWalletForm((prev) => ({ ...prev, secretMaterial: event.target.value }))}
          placeholder={walletFormIsWatchOnly ? 'Watch-only: do not paste a private key or mnemonic here.' : 'Optional mnemonic or existing tcx-wasm keystore JSON. Leave empty to create a random wallet.'}
          disabled={walletFormIsWatchOnly}
        />
        <div className="crypto-form-row">
          <select
            value={walletForm.chain}
            onChange={(event) => setWalletForm((prev) => ({ ...prev, chain: event.target.value }))}
          >
            {chainOptions.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <input
            value={walletForm.network}
            onChange={(event) => setWalletForm((prev) => ({ ...prev, network: event.target.value }))}
            placeholder="Network"
          />
        </div>
        <input
          value={walletForm.address}
          onChange={(event) => setWalletForm((prev) => ({ ...prev, address: event.target.value }))}
          placeholder="Address"
        />
        <input
          value={walletForm.derivationPath}
          onChange={(event) => setWalletForm((prev) => ({ ...prev, derivationPath: event.target.value }))}
          placeholder="Derivation path"
        />
        <button
          className="crypto-action primary"
          onClick={handleSaveWallet}
          disabled={!canSaveCryptoWalletForm(walletForm, savingWallet)}
        >
          {savingWallet ? 'Saving' : walletFormIsWatchOnly ? 'Save Watch Wallet' : 'Save Wallet'}
        </button>
      </div>
    </section>
  )

  if (cryptoMode === 'create') {
    return <div className="crypto-view">{createWalletSection}</div>
  }

  const cryptoNav = (
    <div className="crypto-top-nav">
      <div className="crypto-view-tabs" role="tablist" aria-label="Crypto views">
        {[
          ['home', 'Home'],
          ['portfolio', 'Portfolio'],
          ['advanced', 'Advanced'],
        ].map(([mode, label]) => (
          <button
            key={mode}
            className={`crypto-view-tab ${cryptoMode === mode ? 'active' : ''}`}
            onClick={() => setCryptoMode(mode as CryptoMode)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="crypto-top-actions">
        <button className="crypto-mini-action" onClick={onRefresh} disabled={loading}>
          {loading ? '刷新中' : '刷新'}
        </button>
        <button className="crypto-action primary" onClick={() => setCryptoMode('create')}>
          Create / Import
        </button>
      </div>
    </div>
  )

  const accountSwitcher = accountSwitcherOpen ? (
    <div className="crypto-drawer-backdrop" role="presentation" onClick={() => setAccountSwitcherOpen(false)}>
      <aside className="crypto-account-drawer" role="dialog" aria-modal="true" aria-label="Accounts" onClick={(event) => event.stopPropagation()}>
        <div className="crypto-drawer-header">
          <div>
            <h3>Accounts</h3>
            <p>切换钱包、账户或导入观察地址</p>
          </div>
          <button className="crypto-mini-action" onClick={() => setAccountSwitcherOpen(false)}>
            Close
          </button>
        </div>
        <input className="crypto-account-search" placeholder="搜索账户或地址" />
        <div className="crypto-drawer-list">
          {visibleWallets.length === 0 ? (
            <div className="crypto-empty-state">
              <strong>No wallet yet</strong>
              <span>Create, import, or watch an address to begin.</span>
            </div>
          ) : (
            visibleWallets.map((wallet) => (
              <section key={wallet.id} className="crypto-drawer-wallet">
                <div className="crypto-drawer-wallet-title">
                  <span>{wallet.name}</span>
                  <small>{wallet.accounts.length} accounts · {wallet.tokens.length} tokens</small>
                </div>
                {wallet.accounts.map((account, index) => {
                  const accountTokens = getAccountTokens(wallet, account)
                  const balance = accountTokens
                    .map((token) => Number(token.balance || 0))
                    .filter((value) => Number.isFinite(value))
                    .reduce((sum, value) => sum + value, 0)
                  const active = primaryAccount?.id === account.id
                  return (
                    <button
                      key={account.id}
                      className={`crypto-drawer-account ${active ? 'active' : ''}`}
                      onClick={() => {
                        setSelectedWalletId(wallet.id)
                        setSelectedAccountId(account.id)
                        setAccountSwitcherOpen(false)
                        setCryptoMode('home')
                      }}
                    >
                      <span className="crypto-avatar">{index + 1}</span>
                      <span className="crypto-wallet-copy">
                        <span className="crypto-wallet-name">Account {index + 1}</span>
                        <span className="crypto-wallet-meta">
                          {account.chain} · {shortAddress(account.address)}
                        </span>
                      </span>
                      <span className="crypto-wallet-value">{balance ? balance.toLocaleString() : 'US$--'}</span>
                    </button>
                  )
                })}
                <button
                  className="crypto-drawer-add"
                  onClick={() => {
                    setSelectedWalletId(wallet.id)
                    setSelectedAccountId(wallet.accounts[0]?.id || null)
                    setAccountSwitcherOpen(false)
                    setCryptoMode('advanced')
                  }}
                >
                  + 添加账户
                </button>
              </section>
            ))
          )}
        </div>
        <div className="crypto-drawer-actions">
          <button className="crypto-action primary" onClick={() => setCryptoMode('create')}>
            Create account
          </button>
          <button className="crypto-action" onClick={() => setCryptoMode('create')}>
            Import private key
          </button>
          <button className="crypto-action" onClick={() => {
            handleUseWatchOnlyTemplate()
            setAccountSwitcherOpen(false)
            setCryptoMode('create')
          }}>
            Watch address
          </button>
          <button className="crypto-action" onClick={() => setCryptoMode('advanced')}>
            Connect hardware
          </button>
        </div>
      </aside>
    </div>
  ) : null

  const tokenInfoModal = tokenInfoView ? (
    <div className="crypto-modal-backdrop" role="presentation" onClick={() => setTokenInfoView(null)}>
      <section
        className="crypto-confirm-modal crypto-token-info-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Token info"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="crypto-section-heading">
          <div className="crypto-token-info-head">
            <TokenLogo candidates={logoByToken[tokenInfoView.token.id]} symbol={tokenInfoView.token.symbol} />
            <div>
              <h3>{tokenInfoView.data?.name || tokenInfoView.token.symbol}</h3>
              <p>
                {tokenInfoView.token.symbol} · {tokenInfoView.token.chain}
                {tokenInfoView.token.contractAddress
                  ? ` · ${shortAddress(tokenInfoView.token.contractAddress)}`
                  : ' · Native'}
              </p>
            </div>
          </div>
          <button className="crypto-mini-action" onClick={() => setTokenInfoView(null)}>
            Close
          </button>
        </div>
        {tokenInfoView.loading ? (
          <p className="crypto-rpc-hint">加载代币介绍中 ...</p>
        ) : tokenInfoView.error ? (
          <p className="crypto-rpc-hint">{tokenInfoView.error}</p>
        ) : (
          <div className="crypto-token-info-body">
            <p>{tokenInfoView.data?.description || '暂无介绍。'}</p>
            <div className="crypto-token-info-links">
              {tokenInfoView.data?.website ? (
                <a href={tokenInfoView.data.website} target="_blank" rel="noreferrer">
                  官网
                </a>
              ) : null}
              {tokenInfoView.data?.explorer ? (
                <a href={tokenInfoView.data.explorer} target="_blank" rel="noreferrer">
                  区块浏览器
                </a>
              ) : null}
            </div>
          </div>
        )}
      </section>
    </div>
  ) : null

  const swapPresets = primaryAccount ? swapPresetTokensByChain[primaryAccount.chain] || [] : []
  const busyModal = sendingTx || swapping

  const homeModals = homeModal && primaryAccount ? (
    <div className="crypto-modal-backdrop" role="presentation" onClick={() => !busyModal && setHomeModal(null)}>
      <section
        className="crypto-confirm-modal crypto-home-modal"
        role="dialog"
        aria-modal="true"
        aria-label={homeModal}
        onClick={(event) => event.stopPropagation()}
      >
        {homeModal === 'send' ? (
          <>
            <div className="crypto-section-heading">
              <div>
                <h3>发送 / Send</h3>
                <p>{selectedWallet?.name} · {shortAddress(primaryAccount.address)} · {primaryAccount.chain}</p>
              </div>
              <button className="crypto-mini-action" onClick={() => setHomeModal(null)} disabled={sendingTx}>Close</button>
            </div>
            <div className="crypto-modal-form">
              <label className="crypto-field-label">资产</label>
              <select
                value={sendModalForm.tokenKey}
                onChange={(event) => {
                  setSendModalStatus(null)
                  setSendModalHash('')
                  setSendModalForm((prev) => ({ ...prev, tokenKey: event.target.value, amount: '' }))
                }}
              >
                {tokenOptions.map((opt) => (
                  <option key={opt.key} value={opt.key}>
                    {opt.symbol}{opt.balance ? ` · 余额 ${opt.balance}` : ''}{opt.contract ? '' : ' · Native'}
                  </option>
                ))}
              </select>
              <span className="crypto-rpc-hint">
                可用余额: {sendOpt?.balance || '--'} {sendOpt?.symbol || ''}
              </span>
              <label className="crypto-field-label">收款地址</label>
              <input
                value={sendModalForm.to}
                onChange={(event) => {
                  setSendModalStatus(null)
                  setSendModalHash('')
                  setSendModalForm((prev) => ({ ...prev, to: event.target.value }))
                }}
                placeholder="0x..."
              />
              <label className="crypto-field-label">数量</label>
              <div className="crypto-amount-row">
                <input
                  value={sendModalForm.amount}
                  onChange={(event) => {
                    setSendModalStatus(null)
                    setSendModalHash('')
                    setSendModalForm((prev) => ({ ...prev, amount: event.target.value }))
                  }}
                  placeholder={`数量 (${sendOpt?.symbol || ''})`}
                />
                <button
                  className="crypto-mini-action"
                  type="button"
                  onClick={() => {
                    setSendModalStatus(null)
                    setSendModalHash('')
                    setSendModalForm((prev) => ({ ...prev, amount: sendOpt?.balance || '' }))
                  }}
                  disabled={!sendOpt?.balance}
                >
                  Max
                </button>
              </div>
              {!selectedWalletUsesPasskey ? (
                <>
                  <label className="crypto-field-label">钱包解锁密码</label>
                  <input
                    value={sendModalForm.unlockSecret}
                    onChange={(event) => setSendModalForm((prev) => ({ ...prev, unlockSecret: event.target.value }))}
                    placeholder="用于本地签名"
                    type="password"
                  />
                </>
              ) : (
                <span className="crypto-rpc-hint">将使用 passkey 进行本地签名。</span>
              )}
              {!sendValidation.ok ? (
                <span className="crypto-validation-hint">{sendValidation.reason}</span>
              ) : (
                <span className="crypto-rpc-hint">交易会先估算 gas，再本地签名并广播。</span>
              )}
              {sendModalStatus ? <span className="crypto-rpc-hint">{sendModalStatus}</span> : null}
              {sendModalHash ? (
                <a
                  className="crypto-tx-hash"
                  href={`${explorerTxBaseByChain[primaryAccount.chain] || ''}${sendModalHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {sendModalHash}
                </a>
              ) : null}
              <button
                className="crypto-action primary"
                onClick={handleHomeSend}
                disabled={sendingTx || !sendValidation.ok}
                title={!sendValidation.ok ? sendValidation.reason : '本地签名并广播'}
              >
                {sendingTx ? '处理中 ...' : '确认发送'}
              </button>
            </div>
          </>
        ) : homeModal === 'receive' ? (
          <>
            <div className="crypto-section-heading">
              <div>
                <h3>收款 / Receive</h3>
                <p>{primaryAccount.chain} · {primaryAccount.network}</p>
              </div>
              <button className="crypto-mini-action" onClick={() => setHomeModal(null)}>Close</button>
            </div>
            <div className="crypto-receive-body">
              <img className="crypto-receive-qr" src={qrDataUrl(primaryAccount.address, 6)} alt="address QR" />
              <code className="crypto-receive-address">{primaryAccount.address}</code>
              <button className="crypto-action primary" onClick={handleCopyAddress}>
                {copied ? '已复制 ✓' : '复制地址'}
              </button>
              <span className="crypto-rpc-hint">
                请仅向此地址转入 {primaryAccount.chain} 网络（及兼容的 EVM 链）资产，跨错网络可能丢失。
              </span>
            </div>
          </>
        ) : (
          <>
            <div className="crypto-section-heading">
              <div>
                <h3>兑换 / Swap</h3>
                <p>Uniswap V3 · {primaryAccount.chain}</p>
              </div>
              <button className="crypto-mini-action" onClick={() => setHomeModal(null)} disabled={swapping}>Close</button>
            </div>
            <div className="crypto-modal-form">
              <label className="crypto-field-label">卖出</label>
              <div className="crypto-amount-row">
                <select
                  value={swapForm.fromTokenKey}
                  onChange={(event) => {
                    setSwapForm((prev) => ({ ...prev, fromTokenKey: event.target.value }))
                    setSwapQuote(null)
                    setSwapQuoteKey('')
                  }}
                >
                  {tokenOptions.map((opt) => (
                    <option key={opt.key} value={opt.key}>
                      {opt.symbol}{opt.balance ? ` · ${opt.balance}` : ''}
                    </option>
                  ))}
                </select>
                <button
                  className="crypto-mini-action"
                  type="button"
                  onClick={() => {
                    setSwapQuote(null)
                    setSwapQuoteKey('')
                    setSwapForm((prev) => ({ ...prev, amount: swapFromOpt?.balance || '' }))
                  }}
                  disabled={!swapFromOpt?.balance}
                >
                  Max
                </button>
              </div>
              <span className="crypto-rpc-hint">
                可用余额: {swapFromOpt?.balance || '--'} {swapFromOpt?.symbol || ''}
              </span>
              <input
                value={swapForm.amount}
                onChange={(event) => {
                  setSwapForm((prev) => ({ ...prev, amount: event.target.value }))
                  setSwapQuote(null)
                  setSwapQuoteKey('')
                }}
                placeholder={`卖出数量 (${swapFromOpt?.symbol || ''})`}
              />
              <label className="crypto-field-label">买入</label>
              {swapPresets.length ? (
                <div className="crypto-swap-presets">
                  <button
                    className={`crypto-chip ${!swapForm.toContract ? 'active' : ''}`}
                    onClick={() => {
                      setSwapQuote(null)
                      setSwapQuoteKey('')
                      setSwapForm((prev) => ({ ...prev, toContract: '', toSymbol: nativeSymbolByChain[primaryAccount.chain] || 'ETH', toDecimals: '18' }))
                    }}
                  >
                    {nativeSymbolByChain[primaryAccount.chain] || 'ETH'}
                  </button>
                  {swapPresets.map((preset) => (
                    <button
                      key={preset.address}
                      className={`crypto-chip ${swapForm.toContract.toLowerCase() === preset.address.toLowerCase() ? 'active' : ''}`}
                      onClick={() => {
                        setSwapForm((prev) => ({ ...prev, toContract: preset.address, toSymbol: preset.symbol, toDecimals: String(preset.decimals) }))
                        setSwapQuote(null)
                        setSwapQuoteKey('')
                      }}
                    >
                      {preset.symbol}
                    </button>
                  ))}
                </div>
              ) : null}
              <input
                value={swapForm.toContract}
                onChange={(event) => {
                  setSwapForm((prev) => ({ ...prev, toContract: event.target.value }))
                  setSwapQuote(null)
                  setSwapQuoteKey('')
                }}
                placeholder="买入代币合约地址（留空 = 原生币）"
              />
              <div className="crypto-form-row">
                <input
                  value={swapForm.toSymbol}
                  onChange={(event) => {
                    setSwapQuote(null)
                    setSwapQuoteKey('')
                    setSwapForm((prev) => ({ ...prev, toSymbol: event.target.value }))
                  }}
                  placeholder="买入符号"
                />
                <input
                  value={swapForm.toDecimals}
                  onChange={(event) => {
                    setSwapQuote(null)
                    setSwapQuoteKey('')
                    setSwapForm((prev) => ({ ...prev, toDecimals: event.target.value }))
                  }}
                  placeholder="Decimals"
                />
                <input
                  value={swapForm.slippageBps}
                  onChange={(event) => {
                    setSwapQuote(null)
                    setSwapQuoteKey('')
                    setSwapForm((prev) => ({ ...prev, slippageBps: event.target.value }))
                  }}
                  placeholder="滑点(bps)"
                />
              </div>
              {!selectedWalletUsesPasskey ? (
                <input
                  value={swapForm.unlockSecret}
                  onChange={(event) => setSwapForm((prev) => ({ ...prev, unlockSecret: event.target.value }))}
                  placeholder="钱包解锁密码"
                  type="password"
                />
              ) : null}
              {!swapQuoteValidation.ok ? (
                <span className="crypto-validation-hint">{swapQuoteValidation.reason}</span>
              ) : hasCurrentSwapQuote ? (
                <span className="crypto-rpc-hint">报价有效，可以继续 Swap。</span>
              ) : (
                <span className="crypto-rpc-hint">先获取报价，MyKey 会检查授权额度；不足时会先广播 approve。</span>
              )}
              {swapStatus ? <span className="crypto-rpc-hint">{swapStatus}</span> : null}
              {swapTxHash ? (
                <a
                  className="crypto-tx-hash"
                  href={`${explorerTxBaseByChain[primaryAccount.chain] || ''}${swapTxHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {swapTxHash}
                </a>
              ) : null}
              <div className="crypto-confirm-actions">
                <button
                  className="crypto-action"
                  onClick={handleSwapQuote}
                  disabled={quotingSwap || !swapQuoteValidation.ok}
                  title={!swapQuoteValidation.ok ? swapQuoteValidation.reason : '获取最新报价'}
                >
                  {quotingSwap ? '询价中 ...' : '获取报价'}
                </button>
                <button
                  className="crypto-action primary"
                  onClick={handleSwap}
                  disabled={swapping || !hasCurrentSwapQuote}
                  title={!hasCurrentSwapQuote ? '请先获取最新报价' : '签名并广播 Swap'}
                >
                  {swapping ? '处理中 ...' : 'Swap'}
                </button>
              </div>
              <details className="crypto-swap-advanced">
                <summary>高级：Uniswap 路由 API（可选）</summary>
                <input
                  value={uniswapApiBase}
                  onChange={(event) => setUniswapApiBase(event.target.value)}
                  placeholder="路由网关 base（留空 = 链上 Uniswap V3）"
                />
                <input
                  value={uniswapApiKey}
                  onChange={(event) => setUniswapApiKey(event.target.value)}
                  placeholder="x-api-key（gateway 端点需要）"
                  type="password"
                />
                <span className="crypto-rpc-hint">
                  默认走链上 Uniswap V3（QuoterV2 + SwapRouter02，无需密钥）。公共路由端点会被
                  WAF 拦截；如有自有 Uniswap 路由网关可在此填入以获得多跳最优价，失败时自动回退链上。
                </span>
              </details>
            </div>
          </>
        )}
      </section>
    </div>
  ) : null

  if (cryptoMode === 'home') {
    return (
      <div className="crypto-view">
        {cryptoNav}
        <section className="crypto-home">
          <button className="crypto-account-hero" onClick={() => setAccountSwitcherOpen(true)}>
            <span className="crypto-avatar crypto-avatar-lg">{activeAccountLabel.slice(-1)}</span>
            <span className="crypto-wallet-copy">
              <span className="crypto-wallet-name">
                {selectedWallet?.name || 'MyKey Wallet'} / {activeAccountLabel}
              </span>
              <span className="crypto-wallet-meta">
                {primaryAccount ? `${shortAddress(primaryAccount.address)} · ${primaryAccount.chain}` : 'Create or import a wallet'}
              </span>
            </span>
            <span className="crypto-account-chevron">⌄</span>
          </button>

          <section className="crypto-balance-hero">
            <div>
              <div className="crypto-eyebrow">CURRENT ACCOUNT</div>
              <strong>{scanTotalUsd || (trackedBalanceText === '--' ? 'US$--' : trackedBalanceText)}</strong>
              <p>
                <span className="crypto-loss">24h --</span>
                <span className="crypto-scope-chip">All chains</span>
                <span>
                  {scanningAllChains
                    ? scanStatus || '全链扫描中 ...'
                    : scanStatus
                      ? scanStatus
                      : primaryAccount
                        ? `Updated from ${activeTokens.length} tracked tokens`
                        : 'No active account'}
                </span>
              </p>
            </div>
            <button
              className="crypto-mini-action primary"
              onClick={handleScanAllChains}
              disabled={!primaryAccount || scanningAllChains}
              title="一键扫描所有 EVM 链的原生余额与 ERC-20 资产"
            >
              {scanningAllChains ? '扫描中' : '全链扫描'}
            </button>
            <button className="crypto-mini-action" onClick={onRefresh} disabled={loading}>
              {loading ? '...' : 'Refresh'}
            </button>
            <button
              className="crypto-mini-action"
              onClick={() => primaryAccount && handleQueryBalance(primaryAccount)}
              disabled={!primaryAccount || !rpcForm.rpcUrl || queryingBalance === primaryAccount.id}
            >
              {queryingBalance === primaryAccount?.id ? '...' : 'Balance'}
            </button>
          </section>

          <div className="crypto-action-bar crypto-home-actions">
            <button
              className="crypto-action"
              disabled={!primaryAccount}
              onClick={() => {
                setSendModalStatus(null)
                setSendModalHash('')
                setSendModalForm((prev) => ({ ...prev, tokenKey: tokenOptions[0]?.key || 'native', to: '', amount: '' }))
                setHomeModal('send')
              }}
            >
              Send
            </button>
            <button
              className="crypto-action"
              disabled={!primaryAccount}
              onClick={() => setHomeModal('receive')}
            >
              Receive
            </button>
            <button
              className="crypto-action"
              disabled={!primaryAccount}
              onClick={() => {
                setSwapQuote(null)
                setSwapStatus(null)
                setSwapTxHash('')
                setSwapForm((prev) => ({ ...prev, fromTokenKey: tokenOptions[0]?.key || 'native', amount: '' }))
                setHomeModal('swap')
              }}
            >
              Swap
            </button>
            <button className="crypto-action" disabled title="法币入金（暂未接入）">Buy</button>
          </div>

          <section className="crypto-section-card crypto-assets-card">
            <div className="crypto-asset-tabs">
              {[
                ['tokens', 'Tokens'],
                ['nfts', 'NFTs'],
                ['predictions', '预测'],
                ['leverage', '杠杆'],
                ['activity', 'Activity'],
              ].map(([tab, label]) => (
                <button
                  key={tab}
                  className={`crypto-asset-tab ${assetTab === tab ? 'active' : ''}`}
                  onClick={() => setAssetTab(tab as AssetTab)}
                >
                  {label}
                </button>
              ))}
              <button className="crypto-mini-action" onClick={() => setCryptoMode('advanced')}>
                ...
              </button>
            </div>

            {assetTab === 'tokens' ? (
              activeTokens.length === 0 ? (
                <div className="crypto-empty-state">
                  <strong>No token for this account</strong>
                  <span>去 Advanced 添加 Token 或查询余额。</span>
                </div>
              ) : (
                <div className="crypto-asset-list crypto-token-list">
                  {activeTokens.map((token) => (
                    <div key={token.id} className="crypto-token-row">
                      <TokenLogo candidates={logoByToken[token.id]} symbol={token.symbol} />
                      <span className="crypto-asset-copy">
                        <strong>{token.symbol}</strong>
                        <small>{token.chain} · {token.contractAddress ? shortAddress(token.contractAddress) : 'Native'}</small>
                      </span>
                      <span className="crypto-asset-value">
                        <strong>{balanceByToken[token.id] || token.balance || '--'}</strong>
                        <small>{formatUsd(valueByToken[token.id]) || token.network}</small>
                      </span>
                      <button
                        className="crypto-mini-action"
                        onClick={() => handleShowTokenInfo(token)}
                      >
                        详情
                      </button>
                      <button
                        className="crypto-mini-action"
                        disabled={!primaryAccount}
                        onClick={() => handleUseTokenForSend(token)}
                      >
                        Send
                      </button>
                    </div>
                  ))}
                </div>
              )
            ) : assetTab === 'nfts' ? (
              <div className="crypto-nft-panel">
                <div className="crypto-tab-toolbar">
                  <span>{loadingNfts ? '加载 NFT ...' : `${nfts.length} 个 NFT · 全链`}</span>
                  <button className="crypto-mini-action" onClick={fetchNfts} disabled={loadingNfts || !primaryAccount}>
                    {loadingNfts ? '...' : '刷新'}
                  </button>
                </div>
                {nfts.length === 0 ? (
                  <div className="crypto-empty-state">
                    <strong>{loadingNfts ? '正在扫描 NFT ...' : '未发现 NFT'}</strong>
                    <span>{alchemyApiKey.trim() ? '该地址在已支持的链上没有 NFT，或仍在加载。' : '请先在 Advanced 配置 Alchemy key。'}</span>
                  </div>
                ) : (
                  <div className="crypto-nft-grid">
                    {nfts.map((nft) => (
                      <div key={`${nft.network}-${nft.contractAddress}-${nft.tokenId}`} className="crypto-nft-card">
                        <div className="crypto-nft-media">
                          {nft.imageUrl ? (
                            <img src={nft.imageUrl} alt={nft.name} loading="lazy" referrerPolicy="no-referrer" />
                          ) : (
                            <span className="crypto-nft-placeholder">{nft.tokenType}</span>
                          )}
                          <span className="crypto-nft-chain">{nft.chain}</span>
                        </div>
                        <div className="crypto-nft-meta">
                          <strong title={nft.name}>{nft.name}</strong>
                          <small title={nft.collection || ''}>{nft.collection || shortAddress(nft.contractAddress)}</small>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : assetTab === 'activity' ? (
              <div className="crypto-activity-panel">
                <div className="crypto-tab-toolbar">
                  <span>{loadingActivity ? '加载交易历史 ...' : `${activity.length} 条记录 · 全链`}</span>
                  <button className="crypto-mini-action" onClick={fetchActivity} disabled={loadingActivity || !primaryAccount}>
                    {loadingActivity ? '...' : '刷新'}
                  </button>
                </div>
                {activity.length === 0 ? (
                  <div className="crypto-empty-state">
                    <strong>{loadingActivity ? '正在加载 ...' : '暂无交易记录'}</strong>
                    <span>{alchemyApiKey.trim() ? '该地址在已支持的链上没有可显示的转账记录。' : '请先在 Advanced 配置 Alchemy key。'}</span>
                  </div>
                ) : (
                  <div className="crypto-activity-list">
                    {activity.map((tx) => {
                      const explorer = explorerTxBaseByChain[tx.chain]
                      const inbound = tx.direction === 'in'
                      const label = tx.direction === 'self' ? '自转' : inbound ? '收到' : '转出'
                      const amount = tx.value ? `${inbound ? '+' : '-'}${tx.value} ${tx.asset || ''}` : tx.asset || tx.category
                      const counterparty = inbound ? tx.fromAddress : tx.toAddress
                      return (
                        <div key={`${tx.hash}-${tx.direction}-${tx.asset || ''}`} className="crypto-activity-row">
                          <span className={`crypto-activity-dir ${tx.direction}`}>{label}</span>
                          <span className="crypto-asset-copy">
                            <strong>{amount.trim()}</strong>
                            <small>{tx.chain} · {counterparty ? shortAddress(counterparty) : '合约'}{tx.timestamp ? ` · ${new Date(tx.timestamp).toLocaleDateString()}` : ''}</small>
                          </span>
                          {explorer ? (
                            <a className="crypto-mini-action" href={`${explorer}${tx.hash}`} target="_blank" rel="noreferrer">查看</a>
                          ) : (
                            <span className="crypto-activity-cat">{tx.category}</span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            ) : (
              <div className="crypto-empty-state">
                <strong>{assetTab === 'predictions' ? '预测仓位' : '杠杆仓位'} 暂未接入</strong>
                <span>结构已预留，后续可接预测市场与 Perps/借贷数据。</span>
              </div>
            )}
          </section>
        </section>
        {accountSwitcher}
        {tokenInfoModal}
        {homeModals}
      </div>
    )
  }

  if (cryptoMode === 'portfolio') {
    return (
      <div className="crypto-view">
        {cryptoNav}
        <section className="crypto-portfolio-view">
          <section className="crypto-portfolio-card crypto-portfolio-overview">
            <div>
              <div className="crypto-eyebrow">PORTFOLIO</div>
              <h2>{portfolioSummary.balanceText === '--' ? 'US$--' : portfolioSummary.balanceText}</h2>
              <p>All wallets · {portfolioSummary.accountCount} accounts · {portfolioSummary.chainCount} chains</p>
            </div>
            <div className="crypto-portfolio-kpis">
              <span><strong>{portfolioSummary.walletCount}</strong> Wallets</span>
              <span><strong>{portfolioSummary.accountCount}</strong> Accounts</span>
              <span><strong>{portfolioSummary.tokenCount}</strong> Tokens</span>
            </div>
          </section>

          <div className="crypto-portfolio-grid">
            <section className="crypto-section-card">
              <div className="crypto-section-heading">
                <div>
                  <h3>钱包列表</h3>
                  <p>按钱包查看账户与资产追踪情况</p>
                </div>
              </div>
              <div className="crypto-wallet-list">
                {portfolioSummary.walletRows.map((row) => (
                  <button
                    key={row.wallet.id}
                    className="crypto-wallet-row"
                    onClick={() => {
                      setSelectedWalletId(row.wallet.id)
                      setSelectedAccountId(row.wallet.accounts[0]?.id || null)
                      setCryptoMode('home')
                    }}
                  >
                    <span className="crypto-avatar">{row.wallet.name.slice(0, 1).toUpperCase()}</span>
                    <span className="crypto-wallet-copy">
                      <span className="crypto-wallet-name">{row.wallet.name}</span>
                      <span className="crypto-wallet-meta">{row.accountCount} accounts · {row.chainCount} chains</span>
                    </span>
                    <span className="crypto-wallet-value">{row.balanceText}</span>
                  </button>
                ))}
              </div>
            </section>

            <section className="crypto-section-card">
              <div className="crypto-section-heading">
                <div>
                  <h3>链分布</h3>
                  <p>跨链账户和 Token 分布</p>
                </div>
              </div>
              <div className="crypto-chain-list">
                {portfolioSummary.chainRows.map((row) => (
                  <div key={row.chain} className="crypto-chain-row">
                    <span className="crypto-network-badge">{row.chain}</span>
                    <span>{row.accountCount} accounts</span>
                    <strong>{row.tokenCount} tokens</strong>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <section className="crypto-section-card">
            <div className="crypto-section-heading">
              <div>
                <h3>Token 聚合表</h3>
                <p>同名 Token 跨账户、跨链聚合</p>
              </div>
            </div>
            <div className="crypto-token-table">
              <div className="crypto-token-table-head">
                <span>Token</span>
                <span>Chains</span>
                <span>Accounts</span>
                <span>Amount</span>
              </div>
              {portfolioSummary.tokenRows.map((row) => {
                const extra = portfolioSymbolExtras.get(row.symbol.toUpperCase())
                return (
                  <div key={row.symbol} className="crypto-token-table-row">
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <TokenLogo candidates={extra?.logo} symbol={row.symbol} />
                      <strong>{row.symbol}</strong>
                    </span>
                    <span>{row.chainCount}</span>
                    <span>{row.accountCount || '--'}</span>
                    <span>
                      {row.balanceText}
                      {extra && extra.valueUsd > 0
                        ? ` · $${extra.valueUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                        : ''}
                    </span>
                  </div>
                )
              })}
            </div>
          </section>
        </section>
      </div>
    )
  }

  return (
    <div className="crypto-view">
      {cryptoNav}
      <section className="crypto-wallet-surface">
        <div className="crypto-portfolio-card">
          <div>
            <div className="crypto-eyebrow">MYKEY WALLET</div>
            <h2>{selectedWallet?.name || 'MyKey Wallet'}</h2>
            <p>{selectedWallet ? `${selectedChainCount} chains · ${selectedAccountCount} accounts` : 'Create or import a wallet to start.'}</p>
          </div>
          <div className="crypto-balance-block">
            <span>Tracked Balance</span>
            <strong>{trackedBalanceText}</strong>
          </div>
        </div>

        <div className="crypto-action-bar">
          <button className="crypto-action primary" onClick={() => setCryptoMode('create')}>
            Create / Import
          </button>
          <button className="crypto-action primary" onClick={onRefresh} disabled={loading}>
            {loading ? 'Refreshing' : 'Refresh'}
          </button>
          <button
            className="crypto-action"
            disabled={!selectedWallet || !activeAccountCanSign || !rpcForm.rpcUrl || !rpcForm.signedRawTx}
            onClick={handleBroadcastTx}
          >
            {broadcastingTx ? 'Sending' : 'Send'}
          </button>
          <button className="crypto-action" disabled={!selectedWallet || !rpcForm.rpcUrl || !primaryAccount} onClick={() => primaryAccount && handleQueryBalance(primaryAccount)}>
            Balance
          </button>
        </div>

        <div className="crypto-main-grid">
          <div className="crypto-main-column">
            <section className="crypto-section-card">
              <div className="crypto-section-heading">
                <div>
                  <h3>Wallets</h3>
                  <p>{visibleWallets.length} local vault entries</p>
                </div>
                <span className="crypto-pill">{visibleWallets.length}</span>
              </div>

              {visibleWallets.length === 0 ? (
                <div className="crypto-empty-state">
                  <strong>No crypto wallet yet</strong>
                  <span>Import a tcx-wasm keystore, mnemonic, or watch-only account.</span>
                </div>
              ) : (
                <div className="crypto-wallet-list">
                  {visibleWallets.map((wallet) => (
                    <button
                      key={wallet.id}
                      className={`crypto-wallet-row ${selectedWallet?.id === wallet.id ? 'active' : ''}`}
                      onClick={() => setSelectedWalletId(wallet.id)}
                    >
                      <span className="crypto-avatar">{wallet.name.slice(0, 1).toUpperCase()}</span>
                      <span className="crypto-wallet-copy">
                        <span className="crypto-wallet-name">{wallet.name}</span>
                        <span className="crypto-wallet-meta">
                          {wallet.walletType} · {wallet.accounts.length} chains
                        </span>
                      </span>
                      <span className="crypto-wallet-value">{wallet.tokens.length} tokens</span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="crypto-section-card">
              <div className="crypto-section-heading">
                <div>
                  <h3>Tokens</h3>
                  <p>Token-centric portfolio view</p>
                </div>
                <span className="crypto-pill">{selectedTokenCount}</span>
              </div>
              {!visibleSelectedWallet || visibleSelectedWallet.tokens.length === 0 ? (
                <div className="crypto-empty-state">
                  <strong>No tracked token</strong>
                  <span>Add native or contract assets from the tools panel.</span>
                </div>
              ) : (
                <div className="crypto-asset-list">
                  {visibleSelectedWallet.tokens.map((token) => (
                    <div key={token.id} className="crypto-asset-row">
                      <TokenLogo candidates={logoByToken[token.id]} symbol={token.symbol} />
                      <span className="crypto-asset-copy">
                        <strong>{token.symbol}</strong>
                        <small>{token.chain} · {token.contractAddress || 'native'}</small>
                      </span>
                      <span className="crypto-asset-value">
                        <strong>{balanceByToken[token.id] || token.balance || '--'}</strong>
                        <small>{formatUsd(valueByToken[token.id]) || token.network}</small>
                      </span>
                      <button
                        className="crypto-mini-action"
                        disabled={!rpcForm.rpcUrl || !token.contractAddress || queryingTokenBalance === token.id}
                        onClick={() => handleQueryTokenBalance(token)}
                      >
                        {queryingTokenBalance === token.id ? '...' : 'ERC20'}
                      </button>
                      <button
                        className="crypto-mini-action"
                        onClick={() => handleShowTokenInfo(token)}
                      >
                        详情
                      </button>
                      <button
                        className="crypto-mini-action"
                        disabled={!primaryAccount}
                        onClick={() => handleUseTokenForSend(token)}
                      >
                        Send
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="crypto-section-card">
              <div className="crypto-section-heading">
                <div>
                  <h3>Accounts</h3>
                  <p>Networks derived under this wallet</p>
                </div>
                <span className="crypto-pill">{selectedAccountCount}</span>
              </div>
              {!selectedWallet || selectedWallet.accounts.length === 0 ? (
                <div className="crypto-empty-state">
                  <strong>No account</strong>
                  <span>Add a derived address to track chain activity.</span>
                </div>
              ) : (
                <div className="crypto-account-list">
                  {selectedWallet.accounts.map((account) => (
                    <div key={account.id} className="crypto-account-row">
                      <span className="crypto-network-badge">{account.chain}</span>
                      <code>{account.address}</code>
                      <small>{balanceByAccount[account.id] ? `${balanceByAccount[account.id]} ETH` : account.derivationPath || account.network}</small>
                      <button
                        className="crypto-mini-action"
                        disabled={!rpcForm.rpcUrl || queryingBalance === account.id}
                        onClick={() => handleQueryBalance(account)}
                      >
                        {queryingBalance === account.id ? '...' : 'Balance'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          <aside className="crypto-tools-panel">
            <div className="crypto-tools-header">
              <h3>Wallet Tools</h3>
              {selectedWallet ? (
                <button className="crypto-danger-action" onClick={() => handleDeleteWallet(selectedWallet)}>
                  Delete
                </button>
              ) : null}
            </div>

            <div className="crypto-tool-block">
              <div className="crypto-tool-title">Add Network</div>
              <input
                value={walletUnlockSecret}
                onChange={(event) => setWalletUnlockSecret(event.target.value)}
                placeholder={selectedWalletUsesPasskey ? 'Optional: use passkey automatically' : 'Wallet unlock password'}
                type="password"
              />
              <div className="crypto-form-row">
                <select
                  value={accountForm.chain}
                  onChange={(event) => setAccountForm((prev) => ({ ...prev, chain: event.target.value }))}
                >
                  {chainOptions.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
                <input
                  value={accountForm.network}
                  onChange={(event) => setAccountForm((prev) => ({ ...prev, network: event.target.value }))}
                  placeholder="Network"
                />
              </div>
              <input
                value={accountForm.address}
                onChange={(event) => setAccountForm((prev) => ({ ...prev, address: event.target.value }))}
                placeholder="Derived address, optional when unlock secret is provided"
              />
              <input
                value={accountForm.derivationPath}
                onChange={(event) => setAccountForm((prev) => ({ ...prev, derivationPath: event.target.value }))}
                placeholder="Derivation path"
              />
              <button
                className="crypto-action primary"
                onClick={handleAddAccount}
                disabled={!selectedWallet || savingAccount || (!accountForm.address && !walletUnlockSecret && !selectedWalletUsesPasskey)}
              >
                {savingAccount ? 'Saving' : 'Add Account'}
              </button>
            </div>

            <div className="crypto-tool-block">
              <div className="crypto-tool-title">Add Token</div>
              <input
                value={tokenForm.symbol}
                onChange={(event) => setTokenForm((prev) => ({ ...prev, symbol: event.target.value }))}
                placeholder="Symbol, e.g. USDC"
              />
              <input
                value={tokenForm.contractAddress}
                onChange={(event) => setTokenForm((prev) => ({ ...prev, contractAddress: event.target.value }))}
                placeholder="Contract address, native 可留空"
              />
              <div className="crypto-form-row">
                <input
                  value={tokenForm.decimals}
                  onChange={(event) => setTokenForm((prev) => ({ ...prev, decimals: event.target.value }))}
                  placeholder="Decimals"
                />
                <input
                  value={tokenForm.balance}
                  onChange={(event) => setTokenForm((prev) => ({ ...prev, balance: event.target.value }))}
                  placeholder="Balance，可留空"
                />
              </div>
              <button className="crypto-action primary" onClick={handleAddToken} disabled={savingToken || !tokenForm.symbol}>
                {savingToken ? 'Saving' : 'Add Token'}
              </button>
            </div>

            <div className="crypto-tool-block">
              <div className="crypto-tool-title">RPC & Send</div>
              <div className="crypto-rpc-preset">
                <div>
                  <strong>Alchemy</strong>
                  <span>
                    {alchemyApiKey ? `Key ${maskAlchemyApiKey(alchemyApiKey)}` : 'Multi-chain JSON-RPC / Token API'}
                    {' · '}
                    <a href={ALCHEMY_DOCS_URL} target="_blank" rel="noreferrer">Docs</a>
                  </span>
                </div>
                <button className="crypto-mini-action" onClick={() => handleUseAlchemyRpc()}>
                  Use RPC
                </button>
              </div>
              <select
                value={selectedAlchemyPresetId}
                onChange={(event) => {
                  setSelectedAlchemyPresetId(event.target.value)
                  handleUseAlchemyRpc(event.target.value)
                }}
              >
                {ALCHEMY_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}{preset.testnet ? ' · Testnet' : ''}
                  </option>
                ))}
              </select>
              <input
                value={alchemyApiKey}
                onChange={(event) => setAlchemyApiKey(event.target.value)}
                placeholder="Alchemy API key"
                type="password"
              />
              <div className="crypto-key-actions">
                <span className="crypto-rpc-hint">来源: {walletKeySourceLabel(alchemyKeySource)}</span>
                <button
                  className="crypto-mini-action"
                  onClick={() => handleSaveWalletKey('alchemy')}
                  disabled={savingAlchemyKey || alchemyKeySource === 'env'}
                  title={alchemyKeySource === 'env' ? '.env 已定义该 key，覆盖 Vault' : '加密保存到本地 Vault'}
                >
                  {savingAlchemyKey ? '保存中' : '存到 Vault'}
                </button>
              </div>
              <input
                value={rpcForm.rpcUrl}
                onChange={(event) => setRpcForm((prev) => ({ ...prev, rpcUrl: event.target.value }))}
                placeholder="EVM RPC URL"
              />
              <button
                className="crypto-action primary"
                onClick={handleScanAllChains}
                disabled={!selectedWallet || !primaryAccount || !alchemyApiKey.trim() || scanningAllChains}
                title="对当前地址扫描所有 EVM 链的原生余额与 ERC-20 资产"
              >
                {scanningAllChains ? (scanStatus || '全链扫描中') : '全链扫描 (Scan all EVM chains)'}
              </button>
              {scanStatus && !scanningAllChains ? (
                <span className="crypto-rpc-hint">{scanStatus}</span>
              ) : null}
              <button
                className="crypto-action"
                onClick={handleDiscoverAlchemyTokens}
                disabled={!selectedWallet || !primaryAccount || !rpcForm.rpcUrl || discoveringAlchemyTokens}
              >
                {discoveringAlchemyTokens ? 'Discovering' : '仅当前链 Discover ERC20'}
              </button>
              <div className="crypto-rpc-preset">
                <div>
                  <strong>OKLink</strong>
                  <span>
                    {oklinkApiKey ? `Key ${maskOklinkApiKey(oklinkApiKey)}` : 'Explorer address summary / token balance'}
                    {' · '}
                    <a href={OKLINK_DOCS_URL} target="_blank" rel="noreferrer">Docs</a>
                  </span>
                </div>
                <button
                  className="crypto-mini-action"
                  onClick={handleDiscoverOklinkAssets}
                  disabled={!selectedWallet || !primaryAccount || !oklinkApiKey || discoveringOklinkAssets}
                >
                  {discoveringOklinkAssets ? '...' : 'Discover'}
                </button>
              </div>
              <input
                value={oklinkApiKey}
                onChange={(event) => setOklinkApiKey(event.target.value)}
                placeholder="OKLink API key"
                type="password"
              />
              <div className="crypto-key-actions">
                <span className="crypto-rpc-hint">来源: {walletKeySourceLabel(oklinkKeySource)}</span>
                <button
                  className="crypto-mini-action"
                  onClick={() => handleSaveWalletKey('oklink')}
                  disabled={savingOklinkKey || oklinkKeySource === 'env'}
                  title={oklinkKeySource === 'env' ? '.env 已定义该 key，覆盖 Vault' : '加密保存到本地 Vault'}
                >
                  {savingOklinkKey ? '保存中' : '存到 Vault'}
                </button>
              </div>
              {walletEnvPath ? (
                <span className="crypto-rpc-hint">
                  手动编辑 .env：{walletEnvPath}（写 ALCHEMY_API_KEY / OKLINK_API_KEY，优先级高于 Vault）
                </span>
              ) : null}
              <div className="crypto-form-row">
                <select
                  value={sendForm.assetMode}
                  onChange={(event) => setSendForm((prev) => ({ ...prev, assetMode: event.target.value }))}
                >
                  <option value="native">Native ETH</option>
                  <option value="erc20">ERC20 Token</option>
                </select>
                <input
                  value={sendForm.chainId}
                  onChange={(event) => setSendForm((prev) => ({ ...prev, chainId: event.target.value }))}
                  placeholder="Chain ID"
                />
              </div>
              {sendForm.assetMode === 'erc20' ? (
                <div className="crypto-form-row">
                  <input
                    value={sendForm.tokenContract}
                    onChange={(event) => setSendForm((prev) => ({ ...prev, tokenContract: event.target.value }))}
                    placeholder="ERC20 contract"
                  />
                  <input
                    value={sendForm.tokenDecimals}
                    onChange={(event) => setSendForm((prev) => ({ ...prev, tokenDecimals: event.target.value }))}
                    placeholder="Decimals"
                  />
                </div>
              ) : null}
              <input
                value={sendForm.to}
                onChange={(event) => setSendForm((prev) => ({ ...prev, to: event.target.value }))}
                placeholder="Recipient address"
              />
              <div className="crypto-form-row">
                <input
                  value={sendForm.valueEth}
                  onChange={(event) => setSendForm((prev) => ({ ...prev, valueEth: event.target.value }))}
                  placeholder={sendForm.assetMode === 'erc20' ? 'Token amount' : 'Amount ETH'}
                />
                <input
                  value={sendForm.nonce}
                  onChange={(event) => setSendForm((prev) => ({ ...prev, nonce: event.target.value }))}
                  placeholder="Nonce"
                />
              </div>
              <div className="crypto-form-row">
                <input
                  value={sendForm.maxFeePerGas}
                  onChange={(event) => setSendForm((prev) => ({ ...prev, maxFeePerGas: event.target.value }))}
                  placeholder="Max fee per gas wei"
                />
                <input
                  value={sendForm.maxPriorityFeePerGas}
                  onChange={(event) => setSendForm((prev) => ({ ...prev, maxPriorityFeePerGas: event.target.value }))}
                  placeholder="Priority fee wei"
                />
              </div>
              <div className="crypto-form-row">
                <input
                  value={sendForm.gasLimit}
                  onChange={(event) => setSendForm((prev) => ({ ...prev, gasLimit: event.target.value }))}
                  placeholder="Gas limit"
                />
                <input
                  value={sendForm.gasPrice}
                  onChange={(event) => setSendForm((prev) => ({ ...prev, gasPrice: event.target.value }))}
                  placeholder="Legacy gas price wei"
                />
              </div>
              <button
                className="crypto-action"
                onClick={handleLoadGasDefaults}
                disabled={
                  !activeAccountCanSign ||
                  loadingGasDefaults ||
                  !rpcForm.rpcUrl ||
                  !primaryAccount ||
                  (sendForm.assetMode === 'native' && !sendForm.to) ||
                  (sendForm.assetMode === 'erc20' && (!sendForm.tokenContract || !sendForm.to))
                }
              >
                {loadingGasDefaults ? 'Loading gas' : 'Auto Nonce / Gas'}
              </button>
              <textarea
                value={rpcForm.txInputJson}
                onChange={(event) => setRpcForm((prev) => ({ ...prev, txInputJson: event.target.value }))}
                placeholder="Advanced unsigned tx JSON override"
              />
              <button
                className="crypto-action"
                onClick={handlePrepareTx}
                disabled={
                  signingTx ||
                  !activeAccountCanSign ||
                  !selectedWallet ||
                  !primaryAccount ||
                  (!rpcForm.txInputJson &&
                    (!sendForm.to ||
                      !sendForm.valueEth ||
                      !sendForm.nonce ||
                      (sendForm.assetMode === 'erc20' && !sendForm.tokenContract)))
                }
              >
                Review & Sign
              </button>
              <textarea
                value={rpcForm.signedRawTx}
                onChange={(event) => setRpcForm((prev) => ({ ...prev, signedRawTx: event.target.value }))}
                placeholder="Signed raw transaction (0x...)"
              />
              <button
                className="crypto-action primary"
                onClick={handleBroadcastTx}
                disabled={broadcastingTx || !activeAccountCanSign || !rpcForm.rpcUrl || !rpcForm.signedRawTx}
              >
                {broadcastingTx ? 'Sending' : 'Broadcast'}
              </button>
              {broadcastHash ? <code className="crypto-tx-hash">{broadcastHash}</code> : null}
            </div>
          </aside>
        </div>
      </section>

      {tokenInfoModal}

      {pendingTxInput ? (
        <div className="crypto-modal-backdrop" role="presentation">
          <section className="crypto-confirm-modal" role="dialog" aria-modal="true" aria-label="Confirm transaction">
            <div className="crypto-section-heading">
              <div>
                <h3>Confirm Transaction</h3>
                <p>Review the tx input before tcx-wasm signs it locally.</p>
              </div>
              <button className="crypto-mini-action" onClick={() => setPendingTxInput(null)} disabled={signingTx}>
                Close
              </button>
            </div>
            <div className="crypto-confirm-grid">
              <span>Wallet</span>
              <strong>{selectedWallet?.name || '--'}</strong>
              <span>From</span>
              <code>{primaryAccount?.address || '--'}</code>
              <span>To</span>
              <code>{String(pendingTxInput.to || '--')}</code>
              <span>Value</span>
              <strong>{String(pendingTxInput.value || '0')}</strong>
              <span>Gas</span>
              <strong>{String(pendingTxInput.gasLimit || '--')}</strong>
            </div>
            <textarea className="crypto-confirm-json" value={JSON.stringify(pendingTxInput, null, 2)} readOnly />
            <div className="crypto-confirm-actions">
              <button className="crypto-action" onClick={() => setPendingTxInput(null)} disabled={signingTx}>
                Cancel
              </button>
              <button
                className="crypto-action primary"
                onClick={handleSignTx}
                disabled={signingTx || !activeAccountCanSign || (!walletUnlockSecret && !selectedWalletUsesPasskey)}
              >
                {signingTx ? 'Signing' : 'Confirm & Sign'}
              </button>
            </div>
          </section>
        </div>
      ) : null}

    </div>
  )
}
