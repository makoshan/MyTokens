import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  formatSwapQuoteSummary,
  validateCryptoSend,
  validateCryptoSwap,
  type CryptoSpendOption,
} from '../src/utils/cryptoTransactions'

const eth: CryptoSpendOption = {
  key: 'native',
  symbol: 'ETH',
  contract: null,
  decimals: 18,
  balance: '1.25',
}

const usdc: CryptoSpendOption = {
  key: 'usdc',
  symbol: 'USDC',
  contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  decimals: 6,
  balance: '125.5',
}

test('validateCryptoSend accepts a funded native transfer and returns base units', () => {
  const result = validateCryptoSend({
    hasAccount: true,
    canSign: true,
    hasRpcUrl: true,
    chainId: '1',
    token: eth,
    to: '0xff709659a2646d734ea5735829de2b2f51f82c27',
    amount: '0.25',
    unlockRequired: true,
    unlockSecret: 'wallet-password',
  })

  assert.equal(result.ok, true)
  assert.equal(result.amountBaseUnits, '250000000000000000')
})

test('validateCryptoSend rejects bad recipient amount and balance before signing', () => {
  assert.equal(validateCryptoSend({
    hasAccount: true,
    canSign: true,
    hasRpcUrl: true,
    chainId: '1',
    token: eth,
    to: 'not-an-address',
    amount: '0.1',
    unlockRequired: false,
  }).reason, '收款地址不是有效 EVM 地址。')

  assert.equal(validateCryptoSend({
    hasAccount: true,
    canSign: true,
    hasRpcUrl: true,
    chainId: '1',
    token: usdc,
    to: '0xff709659a2646d734ea5735829de2b2f51f82c27',
    amount: '0',
    unlockRequired: false,
  }).reason, '请输入大于 0 的数量。')

  assert.equal(validateCryptoSend({
    hasAccount: true,
    canSign: true,
    hasRpcUrl: true,
    chainId: '1',
    token: usdc,
    to: '0xff709659a2646d734ea5735829de2b2f51f82c27',
    amount: '126',
    unlockRequired: false,
  }).reason, '余额不足。')
})

test('validateCryptoSwap rejects same-token swaps and unsafe slippage', () => {
  assert.equal(validateCryptoSwap({
    hasAccount: true,
    canSign: true,
    hasRpcUrl: true,
    chainId: '1',
    fromToken: eth,
    toContract: '',
    amount: '0.1',
    slippageBps: '50',
  }).reason, '不能兑换同一种资产。')

  assert.equal(validateCryptoSwap({
    hasAccount: true,
    canSign: true,
    hasRpcUrl: true,
    chainId: '1',
    fromToken: usdc,
    toContract: '',
    amount: '1',
    slippageBps: '9000',
  }).reason, '滑点必须在 0.01% 到 50% 之间。')
})

test('validateCryptoSwap accepts an ERC20 to native quote request', () => {
  const result = validateCryptoSwap({
    hasAccount: true,
    canSign: true,
    hasRpcUrl: true,
    chainId: '1',
    fromToken: usdc,
    toContract: '',
    amount: '25.5',
    slippageBps: '75',
  })

  assert.equal(result.ok, true)
  assert.equal(result.tokenIn, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')
  assert.equal(result.tokenOut, 'ETH')
  assert.equal(result.amountBaseUnits, '25500000')
  assert.equal(result.slippageBps, 75)
})

test('formatSwapQuoteSummary shows expected and minimum output', () => {
  const summary = formatSwapQuoteSummary({
    quote: {
      amountIn: '25500000',
      amountOut: '10000000000000000',
      amountOutMin: '9900000000000000',
      quoteDecimals: null,
      estimatedGas: '180000',
      to: '0x1111111111111111111111111111111111111111',
      calldata: '0x',
      value: '0',
      router: 'SwapRouter02 (fee 500)',
      source: 'onchain-uniswap-v3',
    },
    outputSymbol: 'ETH',
    outputDecimals: 18,
    slippageBps: 100,
  })

  assert.equal(
    summary,
    '预计获得 ≈ 0.01 ETH · 最少 0.0099 ETH · 滑点 1.00% · 链上 Uniswap V3 · SwapRouter02 (fee 500) · Gas 180000'
  )
})

test('crypto home Send and Swap entry points stay open for active accounts', () => {
  const source = readFileSync('src/components/CryptoWalletManager.tsx', 'utf8')
  const homeActions = source.match(/<div className="crypto-action-bar crypto-home-actions">([\s\S]*?)<\/div>/)?.[1] || ''

  assert.equal(
    /disabled=\{!activeAccountCanSign\}/.test(homeActions),
    false,
    'home Send/Swap should open their dialogs; signer checks belong inside the dialogs'
  )
})

test('token row Send opens the send dialog with the selected token', () => {
  const source = readFileSync('src/components/CryptoWalletManager.tsx', 'utf8')
  const handler = source.match(/const handleUseTokenForSend = \(token: CryptoToken\) => \{([\s\S]*?)\n  \}/)?.[1] || ''

  assert.match(handler, /setSendModalForm/, 'token Send should choose the clicked token in the home send form')
  assert.match(handler, /setHomeModal\('send'\)/, 'token Send should open the Send dialog')
})
