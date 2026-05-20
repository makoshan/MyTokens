export type AlchemyNetworkPreset = {
  id: string
  label: string
  chain: string
  network: string
  chainId: string
  host: string
  testnet?: boolean
}

export const ALCHEMY_DOCS_URL = 'https://www.alchemy.com/docs'

export const ALCHEMY_ETH_MAINNET: AlchemyNetworkPreset = {
  id: 'eth-mainnet',
  label: 'Ethereum Mainnet',
  chain: 'ETHEREUM',
  network: 'MAINNET',
  chainId: '1',
  host: 'eth-mainnet.g.alchemy.com',
}

export const ALCHEMY_PRESETS: AlchemyNetworkPreset[] = [
  ALCHEMY_ETH_MAINNET,
  {
    id: 'base-mainnet',
    label: 'Base Mainnet',
    chain: 'BASE',
    network: 'MAINNET',
    chainId: '8453',
    host: 'base-mainnet.g.alchemy.com',
  },
  {
    id: 'arb-mainnet',
    label: 'Arbitrum One',
    chain: 'ARBITRUM',
    network: 'MAINNET',
    chainId: '42161',
    host: 'arb-mainnet.g.alchemy.com',
  },
  {
    id: 'opt-mainnet',
    label: 'OP Mainnet',
    chain: 'OPTIMISM',
    network: 'MAINNET',
    chainId: '10',
    host: 'opt-mainnet.g.alchemy.com',
  },
  {
    id: 'polygon-mainnet',
    label: 'Polygon Mainnet',
    chain: 'POLYGON',
    network: 'MAINNET',
    chainId: '137',
    host: 'polygon-mainnet.g.alchemy.com',
  },
  {
    id: 'eth-sepolia',
    label: 'Ethereum Sepolia',
    chain: 'ETHEREUM',
    network: 'SEPOLIA',
    chainId: '11155111',
    host: 'eth-sepolia.g.alchemy.com',
    testnet: true,
  },
  {
    id: 'base-sepolia',
    label: 'Base Sepolia',
    chain: 'BASE',
    network: 'SEPOLIA',
    chainId: '84532',
    host: 'base-sepolia.g.alchemy.com',
    testnet: true,
  },
  {
    id: 'arb-sepolia',
    label: 'Arbitrum Sepolia',
    chain: 'ARBITRUM',
    network: 'SEPOLIA',
    chainId: '421614',
    host: 'arb-sepolia.g.alchemy.com',
    testnet: true,
  },
  {
    id: 'opt-sepolia',
    label: 'OP Sepolia',
    chain: 'OPTIMISM',
    network: 'SEPOLIA',
    chainId: '11155420',
    host: 'opt-sepolia.g.alchemy.com',
    testnet: true,
  },
  {
    id: 'polygon-amoy',
    label: 'Polygon Amoy',
    chain: 'POLYGON',
    network: 'AMOY',
    chainId: '80002',
    host: 'polygon-amoy.g.alchemy.com',
    testnet: true,
  },
]

export function buildAlchemyRpcUrl(apiKey: string, preset: AlchemyNetworkPreset): string {
  const key = apiKey.trim()
  if (!key) {
    throw new Error('Alchemy API key is required')
  }
  return `https://${preset.host}/v2/${encodeURIComponent(key)}`
}

export function maskAlchemyApiKey(apiKey: string): string {
  const key = apiKey.trim()
  if (key.length <= 8) return '••••••'
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

export function findAlchemyPreset(chain?: string | null, network?: string | null): AlchemyNetworkPreset | undefined {
  const normalizedChain = (chain || '').trim().toUpperCase()
  const normalizedNetwork = (network || '').trim().toUpperCase()
  return ALCHEMY_PRESETS.find(
    (preset) => preset.chain === normalizedChain && preset.network === normalizedNetwork
  )
}
