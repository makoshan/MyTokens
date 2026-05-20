import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './CryptoWalletManager.css'
import {
  buildErc20TransferInput,
  buildEthTransferInput,
  encodeErc20TransferCall,
  ethToWeiDecimal,
  formatWeiAsEth,
} from '../utils/assetVault'
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
} from '../utils/cryptoPortfolio'

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

type CryptoMode = 'home' | 'portfolio' | 'advanced' | 'create'
type AssetTab = 'tokens' | 'nfts' | 'predictions' | 'leverage' | 'activity'

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

const alchemyApiKeyStorageKey = 'mykey.crypto.alchemyApiKey'
const oklinkApiKeyStorageKey = 'mykey.crypto.oklinkApiKey'

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

  const activeSelection = useMemo(
    () => getActiveCryptoSelection(wallets, selectedWalletId, selectedAccountId),
    [selectedAccountId, selectedWalletId, wallets]
  )
  const selectedWallet = activeSelection.wallet
  const primaryAccount = activeSelection.account
  const activeTokens = useMemo(
    () => getAccountTokens(selectedWallet, primaryAccount),
    [primaryAccount, selectedWallet]
  )
  const portfolioSummary = useMemo(() => buildCryptoPortfolioSummary(wallets), [wallets])
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
      for (const token of nextTokens.slice(0, 40)) {
        await invoke<CryptoToken>('add_crypto_token', {
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
      }
      if (nextTokens.length === 0) {
        onError(result.length === 0 ? 'Alchemy 未发现当前地址的 ERC-20 余额。' : 'Alchemy 发现的 Token 已经在列表中。')
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
      for (const token of nextTokens.slice(0, 50)) {
        await invoke<CryptoToken>('add_crypto_token', {
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
      }
      if (nextTokens.length === 0) {
        onError(result.length === 0 ? 'OKLink 未发现当前地址资产。' : 'OKLink 发现的资产已经在列表中。')
      }
      await onRefresh()
    } catch (error) {
      onError(`OKLink 发现资产失败: ${String(error)}`)
    } finally {
      setDiscoveringOklinkAssets(false)
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
      await invoke<CryptoToken>('add_crypto_token', {
        walletId: selectedWallet.id,
        accountId: primaryAccount.id,
        chain: primaryAccount.chain,
        network: primaryAccount.network,
        symbol: tokenForm.symbol,
        contractAddress: tokenForm.contractAddress || null,
        decimals: tokenForm.decimals ? Number(tokenForm.decimals) : null,
        balance: tokenForm.balance || null,
        masterPassword,
      })
      setTokenForm({ symbol: '', contractAddress: '', decimals: '18', balance: '' })
      await onRefresh()
    } catch (error) {
      onError(`添加 Token 失败: ${String(error)}`)
    } finally {
      setSavingToken(false)
    }
  }

  const handleUseTokenForSend = (token: CryptoToken) => {
    if (!activeAccountCanSign) return
    setSendForm((prev) => ({
      ...prev,
      assetMode: token.contractAddress ? 'erc20' : 'native',
      tokenContract: token.contractAddress || '',
      tokenDecimals: String(token.decimals ?? 18),
      chainId: chainIdByChain[token.chain] || prev.chainId,
    }))
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
          {wallets.length === 0 ? (
            <div className="crypto-empty-state">
              <strong>No wallet yet</strong>
              <span>Create, import, or watch an address to begin.</span>
            </div>
          ) : (
            wallets.map((wallet) => (
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
              <strong>{trackedBalanceText === '--' ? 'US$--' : trackedBalanceText}</strong>
              <p>
                <span className="crypto-loss">24h --</span>
                <span className="crypto-scope-chip">All chains</span>
                <span>{primaryAccount ? `Updated from ${activeTokens.length} tracked tokens` : 'No active account'}</span>
              </p>
            </div>
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
            <button className="crypto-action" disabled={!activeAccountCanSign}>Send</button>
            <button className="crypto-action" disabled={!primaryAccount}>Receive</button>
            <button className="crypto-action" disabled>Swap</button>
            <button className="crypto-action" disabled>Buy</button>
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
                      <span className="crypto-token-avatar">{token.symbol.slice(0, 1)}</span>
                      <span className="crypto-asset-copy">
                        <strong>{token.symbol}</strong>
                        <small>{token.chain} · {token.contractAddress ? shortAddress(token.contractAddress) : 'Native'}</small>
                      </span>
                      <span className="crypto-asset-value">
                        <strong>{balanceByToken[token.id] || token.balance || '--'}</strong>
                        <small>{token.network}</small>
                      </span>
                      <button
                        className="crypto-mini-action"
                        disabled={!activeAccountCanSign}
                        onClick={() => handleUseTokenForSend(token)}
                      >
                        Send
                      </button>
                    </div>
                  ))}
                </div>
              )
            ) : (
              <div className="crypto-empty-state">
                <strong>{assetTab === 'nfts' ? 'NFTs' : assetTab === 'predictions' ? '预测仓位' : assetTab === 'leverage' ? '杠杆仓位' : 'Activity'} 暂未接入</strong>
                <span>结构已预留，后续可接 NFT、预测市场、Perps/借贷与交易历史数据。</span>
              </div>
            )}
          </section>
        </section>
        {accountSwitcher}
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
              {portfolioSummary.tokenRows.map((row) => (
                <div key={row.symbol} className="crypto-token-table-row">
                  <strong>{row.symbol}</strong>
                  <span>{row.chainCount}</span>
                  <span>{row.accountCount || '--'}</span>
                  <span>{row.balanceText}</span>
                </div>
              ))}
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
                  <p>{wallets.length} local vault entries</p>
                </div>
                <span className="crypto-pill">{wallets.length}</span>
              </div>

              {wallets.length === 0 ? (
                <div className="crypto-empty-state">
                  <strong>No crypto wallet yet</strong>
                  <span>Import a tcx-wasm keystore, mnemonic, or watch-only account.</span>
                </div>
              ) : (
                <div className="crypto-wallet-list">
                  {wallets.map((wallet) => (
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
              {!selectedWallet || selectedWallet.tokens.length === 0 ? (
                <div className="crypto-empty-state">
                  <strong>No tracked token</strong>
                  <span>Add native or contract assets from the tools panel.</span>
                </div>
              ) : (
                <div className="crypto-asset-list">
                  {selectedWallet.tokens.map((token) => (
                    <div key={token.id} className="crypto-asset-row">
                      <span className="crypto-token-avatar">{token.symbol.slice(0, 1)}</span>
                      <span className="crypto-asset-copy">
                        <strong>{token.symbol}</strong>
                        <small>{token.chain} · {token.contractAddress || 'native'}</small>
                      </span>
                      <span className="crypto-asset-value">
                        <strong>{balanceByToken[token.id] || token.balance || '--'}</strong>
                        <small>{token.network}</small>
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
                        disabled={!activeAccountCanSign}
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
              <input
                value={rpcForm.rpcUrl}
                onChange={(event) => setRpcForm((prev) => ({ ...prev, rpcUrl: event.target.value }))}
                placeholder="EVM RPC URL"
              />
              <button
                className="crypto-action"
                onClick={handleDiscoverAlchemyTokens}
                disabled={!selectedWallet || !primaryAccount || !rpcForm.rpcUrl || discoveringAlchemyTokens}
              >
                {discoveringAlchemyTokens ? 'Discovering' : 'Discover ERC20 via Alchemy'}
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
