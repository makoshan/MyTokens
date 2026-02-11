import type { ProviderConfig } from '../types/provider'

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Claude',
  'claude-code': 'Claude Code',
  'anthropic-cli': 'Claude (CLI)',
  antigravity: 'Antigravity (Local)',
  'google-ai': 'Google AI',
  gemini: 'Gemini',
  'azure-openai': 'Azure OpenAI',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  mistral: 'Mistral',
  ollama: 'Ollama',
  perplexity: 'Perplexity',
  together: 'Together',
  xai: 'xAI',
  volcengine: 'Volcengine',
  glm: 'GLM',
  qwen: 'Qwen',
  minimax: 'MiniMax',
  kimi: 'Kimi',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  other: 'Other',
}

const PROVIDER_COLORS: Record<string, string> = {
  openai: '#10a37f',
  anthropic: '#f97316',
  'claude-code': '#f97316',
  'anthropic-cli': '#f97316',
  antigravity: '#7c3aed',
  'google-ai': '#4285f4',
  gemini: '#6366f1',
  'azure-openai': '#2563eb',
  deepseek: '#ec4899',
  openrouter: '#f59e0b',
  groq: '#111827',
  mistral: '#0f766e',
  ollama: '#0ea5e9',
  perplexity: '#111827',
  together: '#9333ea',
  xai: '#334155',
  volcengine: '#dc2626',
  glm: '#16a34a',
  qwen: '#2563eb',
  minimax: '#db2777',
  kimi: '#f97316',
  cursor: '#2563eb',
  opencode: '#0f766e',
  openclaw: '#b45309',
  other: '#6b7280',
}

export function getProviderDisplayName(providerId: string): string {
  return PROVIDER_LABELS[providerId] || providerId
}

export function getProviderColor(providerId: string): string {
  return PROVIDER_COLORS[providerId] || '#999'
}

export function buildProviderSelectOptions(
  providers: ProviderConfig[]
): Array<{ value: string; label: string }> {
  const options = providers.map((provider) => ({
    value: provider.provider,
    label: provider.label || getProviderDisplayName(provider.provider),
  }))
  options.sort((a, b) => a.label.localeCompare(b.label))
  return options
}
