import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildDefaultComputeGatewayPricePayload,
  buildDefaultComputeGatewayRoutingPayload,
  buildProviderTokenSetupPayload,
  buildComputeAdminHeaders,
  COMPUTE_GATEWAY_PROVIDER_PRESETS,
  DEFAULT_PUBLIC_COMPUTE_GATEWAY_URL,
  findConfiguredProviderForComputeProvider,
  findStoredCredentialForComputeProvider,
  getComputeProviderModelOptions,
  normalizeComputeAccountSummary,
  normalizeComputeGatewayUrl,
  shouldShowComputeGatewayOnboarding,
} from '../src/utils/computeGateway'
import type { ComputeAccount } from '../src/types/compute'
import type { ProviderConfig } from '../src/types/provider'

test('buildComputeAdminHeaders redacts raw key from display while sending bearer auth', () => {
  const headers = buildComputeAdminHeaders('admin-secret')

  assert.equal(headers.authorization, 'Bearer admin-secret')
  assert.equal(headers['content-type'], 'application/json')
})

test('normalizeComputeAccountSummary produces operator-facing balances and status', () => {
  const account: ComputeAccount = {
    id: 'acct-1',
    displayName: 'Friends Alpha',
    status: 'active',
    accountGroup: 'friends',
    balanceMicroUsd: 12_345_678,
    reservedMicroUsd: 345_678,
    apiKeyCount: 2,
    dailyBudgetMicroUsd: 50_000_000,
    createdAt: '2026-05-19T00:00:00Z',
    updatedAt: '2026-05-19T00:00:00Z',
  }

  const summary = normalizeComputeAccountSummary(account)

  assert.equal(summary.availableMicroUsd, 12_000_000)
  assert.equal(summary.balanceLabel, '$12.35')
  assert.equal(summary.availableLabel, '$12.00')
  assert.equal(summary.operatorStatus, 'active / friends')
})

test('shouldShowComputeGatewayOnboarding opens first-run setup when no vault admin token exists', () => {
  assert.equal(shouldShowComputeGatewayOnboarding({ adminToken: '', vaultHasGatewayToken: false }), true)
  assert.equal(shouldShowComputeGatewayOnboarding({ adminToken: '   ', vaultHasGatewayToken: false }), true)
  assert.equal(shouldShowComputeGatewayOnboarding({ adminToken: 'adm_live', vaultHasGatewayToken: false }), false)
  assert.equal(shouldShowComputeGatewayOnboarding({ adminToken: '', vaultHasGatewayToken: true }), false)
})

test('compute gateway setup presets include public gateway and OpenAI-compatible Chinese channels', () => {
  assert.equal(DEFAULT_PUBLIC_COMPUTE_GATEWAY_URL, 'https://mykey-compute-gateway.v2eth.workers.dev')
  assert.equal(normalizeComputeGatewayUrl(' https://example.workers.dev/// '), 'https://example.workers.dev')

  const bailian = COMPUTE_GATEWAY_PROVIDER_PRESETS.find((preset) => preset.id === 'bailian')
  const kimi = COMPUTE_GATEWAY_PROVIDER_PRESETS.find((preset) => preset.id === 'kimi')

  assert.equal(bailian?.adapter, 'openai')
  assert.equal(bailian?.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1')
  assert.equal(kimi?.adapter, 'openai')
  assert.equal(kimi?.baseUrl, 'https://api.kimi.com/coding')
  assert.equal(kimi?.defaultModel, 'kimi-for-coding')
})

test('buildProviderTokenSetupPayload maps a selected shared AI token into admin API payloads', () => {
  const providerPayload = buildProviderTokenSetupPayload({
    presetId: 'kimi',
    apiToken: 'sk-kimi',
    label: 'Kimi shared',
    model: 'moonshot-v1-8k',
  })

  assert.equal(providerPayload.provider, 'kimi')
  assert.equal(providerPayload.adapter, 'openai')
  assert.equal(providerPayload.base_url, 'https://api.kimi.com/coding')
  assert.equal(providerPayload.plaintext, 'sk-kimi')
  assert.deepEqual(providerPayload.models, ['moonshot-v1-8k'])

  const pricePayload = buildDefaultComputeGatewayPricePayload(providerPayload.provider, 'moonshot-v1-8k')
  assert.equal(pricePayload.provider, 'kimi')
  assert.equal(pricePayload.model, 'moonshot-v1-8k')
  assert.equal(pricePayload.sell_input_micro_usd_per_1m_tokens, 100_000)

  const routePayload = buildDefaultComputeGatewayRoutingPayload({
    requestedModel: 'moonshot-v1-8k',
    providerTokenId: 'tok-1',
    provider: 'kimi',
  })
  assert.equal(routePayload.account_group, 'friends')
  assert.equal(routePayload.requested_provider, 'kimi')
  assert.equal(routePayload.provider_token_id, 'tok-1')
})

test('findStoredCredentialForComputeProvider matches stored provider ids case-insensitively and via OpenAI-compatible aliases', () => {
  const creds = [
    { id: 'anthropic-1', provider: 'Anthropic', name: 'Claude API key' },
    { id: 'openai-compat-1', provider: 'openai-compatible', name: 'OpenAI prod key' },
  ]

  assert.equal(findStoredCredentialForComputeProvider(creds, 'anthropic')?.id, 'anthropic-1')
  assert.equal(findStoredCredentialForComputeProvider(creds, 'openai')?.id, 'openai-compat-1')
})

test('findConfiguredProviderForComputeProvider reuses BaiLian Token Plan for compute BaiLian', () => {
  const providers = [
    {
      provider: 'bailian-token-plan',
      label: '百炼 Token Plan',
      api_key: 'sk-bailian',
      base_url: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      updated_at: '2026-05-21T00:00:00Z',
      is_active: true,
      models: ['qwen-plus', 'qwen-max'],
      endpoints: [],
      env_vars: [],
      app_bindings: [],
    },
  ] satisfies ProviderConfig[]

  const match = findConfiguredProviderForComputeProvider(providers, 'bailian')

  assert.equal(match?.api_key, 'sk-bailian')
  assert.equal(match?.base_url, 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')
  assert.deepEqual(getComputeProviderModelOptions(match, ['qwen-turbo']), ['qwen-plus', 'qwen-max'])
})

test('findConfiguredProviderForComputeProvider prefers Kimi for Coding for compute Kimi', () => {
  const providers = [
    {
      provider: 'kimi',
      label: 'Kimi',
      api_key: 'sk-kimi-general',
      base_url: 'https://api.moonshot.ai/v1',
      updated_at: '2026-05-21T00:00:00Z',
      is_active: true,
      models: ['moonshot-v1-8k'],
      endpoints: [],
      env_vars: [],
      app_bindings: [],
    },
    {
      provider: 'kimi-for-coding',
      label: 'Kimi for Coding',
      api_key: 'sk-kimi-coding',
      base_url: 'https://api.kimi.com/coding',
      updated_at: '2026-05-21T00:00:00Z',
      is_active: true,
      models: ['kimi-for-coding'],
      endpoints: [],
      env_vars: [],
      app_bindings: [],
    },
  ] satisfies ProviderConfig[]

  const match = findConfiguredProviderForComputeProvider(providers, 'kimi')

  assert.equal(match?.provider, 'kimi-for-coding')
  assert.equal(match?.api_key, 'sk-kimi-coding')
  assert.deepEqual(getComputeProviderModelOptions(match, ['moonshot-v1-8k']), ['kimi-for-coding'])
})
