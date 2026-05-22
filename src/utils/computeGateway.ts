import type { ComputeAccount, ComputeAccountSummary } from '../types/compute'
import type { ProviderConfig, ProviderDetails } from '../types/provider'

export const DEFAULT_PUBLIC_COMPUTE_GATEWAY_URL = 'https://mykey-compute-gateway.v2eth.workers.dev'

export interface ComputeGatewayProviderPreset {
  id: string
  label: string
  provider: string
  adapter: 'openai' | 'anthropic'
  baseUrl: string | null
  defaultModel: string
  models: string[]
}

export interface StoredComputeCredential {
  id: string
  provider: string
  name?: string
}

export const COMPUTE_GATEWAY_PROVIDER_PRESETS: ComputeGatewayProviderPreset[] = [
  {
    id: 'bailian',
    label: '百炼',
    provider: 'bailian',
    adapter: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
  },
  {
    id: 'kimi',
    label: 'Kimi',
    provider: 'kimi',
    adapter: 'openai',
    baseUrl: 'https://api.kimi.com/coding',
    defaultModel: 'kimi-for-coding',
    models: ['kimi-for-coding'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    provider: 'openai',
    adapter: 'openai',
    baseUrl: null,
    defaultModel: 'gpt-4.1-mini',
    models: ['gpt-4.1-mini', 'gpt-4.1'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    provider: 'anthropic',
    adapter: 'anthropic',
    baseUrl: null,
    defaultModel: 'claude-3-5-sonnet',
    models: ['claude-3-5-sonnet', 'claude-3-5-haiku'],
  },
]

export function formatComputeMicroUsd(value: number): string {
  const usd = value / 1_000_000
  if (value > 0 && value < 10_000) {
    return `$${usd.toFixed(6)}`
  }
  return `$${usd.toFixed(2)}`
}

export function buildComputeAdminHeaders(adminKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${adminKey}`,
    'content-type': 'application/json',
  }
}

export function normalizeComputeGatewayUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function normalizeProviderId(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-')
}

function computeProviderAliases(provider: string): Set<string> {
  const normalized = normalizeProviderId(provider)
  const aliases = new Set([normalized])
  if (normalized === 'openai') {
    aliases.add('openai-compatible')
    aliases.add('openai-compatible-api')
  }
  if (normalized === 'bailian') {
    aliases.add('bailian-token-plan')
    aliases.add('dashscope')
    aliases.add('aliyun-bailian')
    aliases.add('alibaba-bailian')
  }
  if (normalized === 'kimi') {
    aliases.add('kimi-for-coding')
    aliases.add('moonshot')
  }
  return aliases
}

function computeProviderAliasPriority(provider: string): string[] {
  const normalized = normalizeProviderId(provider)
  if (normalized === 'kimi') return ['kimi-for-coding', 'kimi', 'moonshot']
  if (normalized === 'bailian') return ['bailian-token-plan', 'bailian', 'dashscope', 'aliyun-bailian', 'alibaba-bailian']
  return Array.from(computeProviderAliases(provider))
}

export function findStoredCredentialForComputeProvider(
  credentials: StoredComputeCredential[],
  provider: string
): StoredComputeCredential | undefined {
  const aliases = computeProviderAliases(provider)
  return credentials.find((credential) => aliases.has(normalizeProviderId(credential.provider)))
}

export function findConfiguredProviderForComputeProvider(
  providers: ProviderConfig[],
  provider: string
): ProviderConfig | undefined {
  const priorities = computeProviderAliasPriority(provider)
  const candidates = providers.filter((item) => item.api_key.trim().length > 0)
  for (const alias of priorities) {
    const match = candidates.find((item) => normalizeProviderId(item.provider) === alias)
    if (match) return match
  }
  return undefined
}

function collectProviderDetailModels(details?: ProviderDetails): string[] {
  if (!details) return []
  return [
    details.main_model,
    details.reasoning_model,
    details.default_haiku_model,
    details.default_sonnet_model,
    details.default_opus_model,
    details.test_model,
  ].filter((item) => item.trim().length > 0)
}

export function getComputeProviderModelOptions(
  provider: ProviderConfig | undefined,
  fallbackModels: string[]
): string[] {
  const source = provider ? [...provider.models, ...collectProviderDetailModels(provider.details)] : fallbackModels
  const seen = new Set<string>()
  return source
    .map((item) => item.trim())
    .filter((item) => {
      if (!item || seen.has(item)) return false
      seen.add(item)
      return true
    })
}

export function shouldShowComputeGatewayOnboarding(input: {
  adminToken: string
  vaultHasGatewayToken?: boolean
}): boolean {
  return !input.vaultHasGatewayToken && input.adminToken.trim().length === 0
}

function providerPresetById(presetId: string): ComputeGatewayProviderPreset {
  const preset = COMPUTE_GATEWAY_PROVIDER_PRESETS.find((candidate) => candidate.id === presetId)
  if (!preset) throw new Error(`unknown_provider_preset:${presetId}`)
  return preset
}

export function buildProviderTokenSetupPayload(input: {
  presetId: string
  apiToken: string
  label?: string
  model?: string
  models?: string[]
  baseUrl?: string | null
}) {
  const preset = providerPresetById(input.presetId)
  const model = input.model?.trim() || preset.defaultModel
  const models = input.models?.map((item) => item.trim()).filter(Boolean) || [model]
  return {
    provider: preset.provider,
    label: input.label?.trim() || `${preset.label} shared token`,
    adapter: preset.adapter,
    base_url: input.baseUrl !== undefined ? input.baseUrl : preset.baseUrl,
    plaintext: input.apiToken.trim(),
    models: Array.from(new Set(models)),
  }
}

export function buildDefaultComputeGatewayPricePayload(provider: string, model: string) {
  return {
    provider,
    model,
    version: 1,
    sell_input_micro_usd_per_1m_tokens: 100_000,
    sell_output_micro_usd_per_1m_tokens: 200_000,
    upstream_input_micro_usd_per_1m_tokens: 50_000,
    upstream_output_micro_usd_per_1m_tokens: 100_000,
  }
}

export function buildDefaultComputeGatewayRoutingPayload(input: {
  requestedModel: string
  providerTokenId: string
  provider: string
  accountGroup?: string
}) {
  return {
    account_group: input.accountGroup ?? 'friends',
    requested_provider: input.provider,
    requested_model: input.requestedModel,
    provider_token_id: input.providerTokenId,
    actual_provider_model: input.requestedModel,
    priority: 1,
    weight: 10,
  }
}

export function normalizeComputeAccountSummary(account: ComputeAccount): ComputeAccountSummary {
  const availableMicroUsd = Math.max(0, account.balanceMicroUsd - account.reservedMicroUsd)
  return {
    ...account,
    availableMicroUsd,
    balanceLabel: formatComputeMicroUsd(account.balanceMicroUsd),
    availableLabel: formatComputeMicroUsd(availableMicroUsd),
    operatorStatus: `${account.status} / ${account.accountGroup}`,
  }
}
