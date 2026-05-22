import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  ALCHEMY_DOCS_URL,
  ALCHEMY_ETH_MAINNET,
  ALCHEMY_PRESETS,
  buildAlchemyRpcUrl,
  findAlchemyPreset,
  maskAlchemyApiKey,
} from '../src/utils/alchemyRpc'

test('buildAlchemyRpcUrl creates an Ethereum mainnet Alchemy URL without hardcoding a key', () => {
  assert.equal(
    buildAlchemyRpcUrl('demo-key', ALCHEMY_ETH_MAINNET),
    'https://eth-mainnet.g.alchemy.com/v2/demo-key'
  )
})

test('buildAlchemyRpcUrl rejects empty API keys', () => {
  assert.throws(() => buildAlchemyRpcUrl('', ALCHEMY_ETH_MAINNET), /Alchemy API key/)
})

test('Alchemy presets include common EVM mainnets from the docs', () => {
  assert.deepEqual(
    ALCHEMY_PRESETS.filter((preset) => !preset.testnet).map((preset) => [preset.id, preset.chainId, preset.host]),
    [
      ['eth-mainnet', '1', 'eth-mainnet.g.alchemy.com'],
      ['base-mainnet', '8453', 'base-mainnet.g.alchemy.com'],
      ['arb-mainnet', '42161', 'arb-mainnet.g.alchemy.com'],
      ['opt-mainnet', '10', 'opt-mainnet.g.alchemy.com'],
      ['polygon-mainnet', '137', 'polygon-mainnet.g.alchemy.com'],
    ]
  )
})

test('findAlchemyPreset can match by account chain and network', () => {
  assert.equal(findAlchemyPreset('BASE', 'MAINNET')?.id, 'base-mainnet')
  assert.equal(findAlchemyPreset('ETHEREUM', 'SEPOLIA')?.id, 'eth-sepolia')
})

test('maskAlchemyApiKey keeps only a short non-secret preview', () => {
  assert.equal(maskAlchemyApiKey('abcdef1234567890'), 'abcd...7890')
  assert.equal(maskAlchemyApiKey('short'), '••••••')
})

test('Alchemy docs link points to official docs', () => {
  assert.equal(ALCHEMY_DOCS_URL, 'https://www.alchemy.com/docs')
})
