import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildModelUseLabel,
  buildModelTestEntries,
  resolveInitialModelTestSelection,
} from '../src/utils/clippyModelTesting'
import type { ProviderConfig } from '../src/types/provider'

function provider(providerId: string, models: string[], overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    provider: providerId,
    label: providerId.toUpperCase(),
    api_key: '',
    base_url: '',
    updated_at: '',
    is_active: true,
    models,
    details: {
      website_url: '',
      notes: '',
      main_model: '',
      reasoning_model: '',
      default_haiku_model: '',
      default_sonnet_model: '',
      default_opus_model: '',
      settings_json: '{}',
      use_common_config: false,
      test_config_enabled: false,
      test_model: '',
      test_prompt: '',
      proxy_config_enabled: false,
      proxy_url: '',
      proxy_username: '',
      proxy_password: '',
    },
    endpoints: [],
    env_vars: [],
    app_bindings: [],
    ...overrides,
  }
}

test('buildModelTestEntries combines configured providers and gateway catalog without duplicate models', () => {
  const entries = buildModelTestEntries(
    [
      provider('openai', ['gpt-4o', 'gpt-4o'], {
        label: 'OpenAI',
        details: {
          website_url: '',
          notes: '',
          main_model: 'gpt-5',
          reasoning_model: '',
          default_haiku_model: '',
          default_sonnet_model: '',
          default_opus_model: '',
          settings_json: '{}',
          use_common_config: false,
          test_config_enabled: false,
          test_model: 'gpt-4.1-mini',
          test_prompt: '',
          proxy_config_enabled: false,
          proxy_url: '',
          proxy_username: '',
          proxy_password: '',
        },
      }),
      provider('anthropic', ['claude-sonnet-4-5']),
    ],
    [
      { app_type: 'codex', provider: 'openai', model: 'gpt-5-codex' },
      { app_type: 'codex', provider: 'openai', model: 'gpt-5-codex' },
    ],
  )

  assert.deepEqual(
    entries.map((entry) => ({
      provider: entry.provider,
      providerLabel: entry.providerLabel,
      models: entry.models,
    })),
    [
      {
        provider: 'anthropic',
        providerLabel: 'ANTHROPIC',
        models: ['claude-sonnet-4-5'],
      },
      {
        provider: 'openai',
        providerLabel: 'OpenAI',
        models: ['gpt-4.1-mini', 'gpt-4o', 'gpt-5', 'gpt-5-codex'],
      },
    ],
  )
})

test('resolveInitialModelTestSelection keeps a valid selection or picks the first available model', () => {
  const entries = buildModelTestEntries(
    [provider('openai', ['gpt-4o']), provider('qwen', ['qwen-max'])],
    [],
  )

  assert.deepEqual(
    resolveInitialModelTestSelection(entries, { provider: 'qwen', model: 'qwen-max' }),
    { provider: 'qwen', model: 'qwen-max' },
  )
  assert.deepEqual(
    resolveInitialModelTestSelection(entries, { provider: 'missing', model: 'ghost' }),
    { provider: 'openai', model: 'gpt-4o' },
  )
})

test('buildModelUseLabel describes the selected provider and model without test wording', () => {
  assert.equal(
    buildModelUseLabel({ providerLabel: '百炼 Token Plan', model: 'deepseek-v3.2' }),
    '使用模型：百炼 Token Plan / deepseek-v3.2',
  )
})
