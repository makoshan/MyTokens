import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  buildCryptoPortfolioSummary,
  canSaveCryptoWalletForm,
  getActiveCryptoSelection,
  getAccountTokens,
  isWatchOnlyWalletConfig,
  normalizeWatchOnlyWalletDefaults,
} from '../src/utils/cryptoPortfolio'

const wallets = [
  {
    id: 'wallet-1',
    name: 'Main Wallet',
    walletType: 'tcx-wasm:password',
    secretKind: 'keystore_json',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    isActive: true,
    accounts: [
      {
        id: 'account-1',
        walletId: 'wallet-1',
        chain: 'ETHEREUM',
        network: 'MAINNET',
        address: '0x1111111111111111111111111111111111111111',
        derivationPath: "m/44'/60'/0'/0/0",
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'account-2',
        walletId: 'wallet-1',
        chain: 'BASE',
        network: 'MAINNET',
        address: '0x2222222222222222222222222222222222222222',
        derivationPath: "m/44'/60'/0'/0/1",
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
    tokens: [
      {
        id: 'token-eth',
        walletId: 'wallet-1',
        accountId: 'account-1',
        chain: 'ETHEREUM',
        network: 'MAINNET',
        symbol: 'ETH',
        contractAddress: null,
        decimals: 18,
        balance: '0.5',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'token-usdt-eth',
        walletId: 'wallet-1',
        accountId: 'account-1',
        chain: 'ETHEREUM',
        network: 'MAINNET',
        symbol: 'USDT',
        contractAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7',
        decimals: 6,
        balance: '100',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'token-usdt-base',
        walletId: 'wallet-1',
        accountId: 'account-2',
        chain: 'BASE',
        network: 'MAINNET',
        symbol: 'USDT',
        contractAddress: '0xbaseusdt',
        decimals: 6,
        balance: '50',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ],
  },
  {
    id: 'wallet-2',
    name: 'Watch Wallet',
    walletType: 'hardware-watch',
    secretKind: 'watch_only',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    isActive: true,
    accounts: [
      {
        id: 'account-3',
        walletId: 'wallet-2',
        chain: 'SOLANA',
        network: 'MAINNET',
        address: 'So11111111111111111111111111111111111111112',
        derivationPath: null,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
    tokens: [
      {
        id: 'token-sol',
        walletId: 'wallet-2',
        accountId: 'account-3',
        chain: 'SOLANA',
        network: 'MAINNET',
        symbol: 'SOL',
        contractAddress: null,
        decimals: 9,
        balance: '2',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ],
  },
]

test('getActiveCryptoSelection falls back to the first wallet and first account', () => {
  const selection = getActiveCryptoSelection(wallets, null, null)

  assert.equal(selection.wallet?.id, 'wallet-1')
  assert.equal(selection.account?.id, 'account-1')
})

test('getAccountTokens returns only tokens for the active account', () => {
  const tokens = getAccountTokens(wallets[0], wallets[0].accounts[1])

  assert.deepEqual(tokens.map((token) => token.id), ['token-usdt-base'])
})

test('buildCryptoPortfolioSummary aggregates wallets chains and token symbols', () => {
  const summary = buildCryptoPortfolioSummary(wallets)

  assert.equal(summary.walletCount, 2)
  assert.equal(summary.accountCount, 3)
  assert.equal(summary.chainCount, 3)
  assert.deepEqual(
    summary.chainRows.map((row) => [row.chain, row.accountCount, row.tokenCount]),
    [
      ['BASE', 1, 1],
      ['ETHEREUM', 1, 2],
      ['SOLANA', 1, 1],
    ]
  )
  assert.deepEqual(
    summary.tokenRows.map((row) => [row.symbol, row.tokenCount, row.chainCount, row.balanceText]),
    [
      ['ETH', 1, 1, '0.5'],
      ['SOL', 1, 1, '2'],
      ['USDT', 2, 2, '150'],
    ]
  )
})

test('watch-only wallet forms can be saved with only a public address', () => {
  const form = {
    name: '',
    walletType: 'hardware-watch',
    secretKind: 'watch_only',
    unlockMode: 'password',
    unlockSecret: '',
    address: '0xff709659a2646d734ea5735829de2b2f51f82c27',
  }

  assert.equal(isWatchOnlyWalletConfig(form), true)
  assert.equal(canSaveCryptoWalletForm(form, false), true)

  const defaults = normalizeWatchOnlyWalletDefaults({
    name: '',
    walletType: 'tcx-wasm',
    secretKind: 'keystore_json',
    unlockMode: 'password',
    unlockSecret: 'should-clear',
    address: '',
  })

  assert.equal(defaults.name, '')
  assert.equal(defaults.walletType, 'hardware-watch')
  assert.equal(defaults.secretKind, 'watch_only')
  assert.equal(defaults.unlockSecret, '')
  assert.equal(defaults.address, '')
})

test('signing wallet forms still require an unlock secret unless passkey PRF is creating it', () => {
  const baseForm = {
    name: 'Signer',
    walletType: 'tcx-wasm',
    secretKind: 'keystore_json',
    unlockMode: 'password',
    unlockSecret: '',
    address: '0x1111111111111111111111111111111111111111',
  }

  assert.equal(canSaveCryptoWalletForm(baseForm, false), false)
  assert.equal(canSaveCryptoWalletForm({ ...baseForm, unlockMode: 'passkey-prf' }, false), true)
  assert.equal(canSaveCryptoWalletForm({ ...baseForm, unlockSecret: 'vault-password' }, false), true)
  assert.equal(canSaveCryptoWalletForm({ ...baseForm, unlockSecret: 'vault-password', address: '' }, false), true)
})
