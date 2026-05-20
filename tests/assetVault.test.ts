import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  buildErc20TransferInput,
  buildEthTransferInput,
  encodeErc20BalanceOfCall,
  encodeErc20TransferCall,
  ethToWeiDecimal,
  formatWeiAsEth,
  summarizeAssets,
  tokenToBaseUnitDecimal,
} from '../src/utils/assetVault'

test('summarizeAssets keeps AI tokens and crypto wallets in one asset inventory', () => {
  const assets = summarizeAssets(
    [
      {
        id: 'ai-1',
        name: 'OpenAI prod',
        provider: 'openai',
        is_active: true,
      },
    ],
    [
      {
        id: 'wallet-1',
        name: 'Main Wallet',
        walletType: 'mnemonic',
        isActive: true,
        accounts: [
          { chain: 'ETHEREUM', address: '0xabc' },
          { chain: 'BITCOIN', address: 'bc1qabc' },
        ],
        tokens: [{ symbol: 'ETH' }, { symbol: 'USDC' }],
      },
    ]
  )

  assert.equal(assets.length, 2)
  assert.deepEqual(assets.map((asset) => asset.kind), ['ai_token', 'crypto_wallet'])
  assert.equal(assets[1].label, 'Main Wallet')
  assert.equal(assets[1].provider, 'mnemonic')
  assert.equal(assets[1].status, 'active')
  if (assets[1].kind !== 'crypto_wallet') {
    throw new Error('expected crypto wallet summary')
  }
  assert.equal(assets[1].chainCount, 2)
  assert.equal(assets[1].tokenCount, 2)
})

test('formatWeiAsEth formats JSON-RPC hex balances for display', () => {
  assert.equal(formatWeiAsEth('0xde0b6b3a7640000'), '1')
  assert.equal(formatWeiAsEth('0x2386f26fc10000'), '0.01')
})

test('ethToWeiDecimal converts decimal ETH values without floating point drift', () => {
  assert.equal(ethToWeiDecimal('1'), '1000000000000000000')
  assert.equal(ethToWeiDecimal('0.000000000000000001'), '1')
  assert.equal(ethToWeiDecimal('2.5'), '2500000000000000000')
})

test('buildEthTransferInput creates a tcx-wasm EIP-1559 transaction input', () => {
  assert.deepEqual(
    buildEthTransferInput({
      to: '0x3535353535353535353535353535353535353535',
      valueEth: '0.01',
      nonce: '7',
      gasLimit: '21000',
      chainId: '1',
      maxFeePerGas: '30000000000',
      maxPriorityFeePerGas: '1000000000',
    }),
    {
      nonce: '7',
      gasLimit: '21000',
      to: '0x3535353535353535353535353535353535353535',
      value: '10000000000000000',
      chainId: '1',
      txType: '02',
      maxFeePerGas: '30000000000',
      maxPriorityFeePerGas: '1000000000',
      accessList: [],
    }
  )
})

test('encodeErc20BalanceOfCall builds balanceOf calldata', () => {
  assert.equal(
    encodeErc20BalanceOfCall('0x000000000000000000000000000000000000dEaD'),
    '0x70a08231000000000000000000000000000000000000000000000000000000000000dead'
  )
})

test('tokenToBaseUnitDecimal converts ERC20 token amounts by decimals', () => {
  assert.equal(tokenToBaseUnitDecimal('1.5', 6), '1500000')
  assert.equal(tokenToBaseUnitDecimal('0.000001', 6), '1')
  assert.throws(() => tokenToBaseUnitDecimal('0.0000001', 6), /decimal places/)
})

test('encodeErc20TransferCall builds transfer calldata', () => {
  assert.equal(
    encodeErc20TransferCall('0x3535353535353535353535353535353535353535', '1.5', 6),
    '0xa9059cbb0000000000000000000000003535353535353535353535353535353535353535000000000000000000000000000000000000000000000000000000000016e360'
  )
})

test('buildErc20TransferInput creates a tcx-wasm contract transfer input', () => {
  assert.deepEqual(
    buildErc20TransferInput({
      contractAddress: '0x1111111111111111111111111111111111111111',
      to: '0x3535353535353535353535353535353535353535',
      amount: '1.5',
      decimals: 6,
      nonce: '7',
      gasLimit: '65000',
      chainId: '1',
      gasPrice: '25000000000',
    }),
    {
      nonce: '7',
      gasLimit: '65000',
      to: '0x1111111111111111111111111111111111111111',
      value: '0',
      chainId: '1',
      data: '0xa9059cbb0000000000000000000000003535353535353535353535353535353535353535000000000000000000000000000000000000000000000000000000000016e360',
      gasPrice: '25000000000',
    }
  )
})
