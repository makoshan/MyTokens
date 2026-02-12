import type { ProviderConfig } from '../types/provider'

export type ProviderCategory = 'model' | 'translation' | 'search' | 'ocr' | 'other'

const PROVIDER_CATEGORY_LABELS: Record<ProviderCategory, string> = {
  model: '模型供应商',
  translation: '翻译供应商',
  search: '搜索供应商',
  ocr: 'OCR 供应商',
  other: 'Other',
}

const PROVIDER_CATEGORIES: Record<string, ProviderCategory> = {
  openai: 'model',
  anthropic: 'model',
  'claude-code': 'model',
  'anthropic-cli': 'model',
  antigravity: 'model',
  'google-ai': 'model',
  gemini: 'model',
  'azure-openai': 'model',
  deepseek: 'model',
  openrouter: 'model',
  groq: 'model',
  mistral: 'model',
  ollama: 'model',
  together: 'model',
  xai: 'model',
  volcengine: 'model',
  glm: 'model',
  qwen: 'model',
  minimax: 'model',
  kimi: 'model',
  'kimi-for-coding': 'model',
  cursor: 'model',
  opencode: 'model',
  openclaw: 'model',
  amp: 'model',
  deepl: 'translation',
  'google-translate': 'translation',
  'google-translate-free': 'translation',
  'microsoft-translate': 'translation',
  'apple-translate': 'translation',
  tavily: 'search',
  serpapi: 'search',
  perplexity: 'search',
  'ocr-space': 'ocr',
  'apple-ocr': 'ocr',
  paddleocr: 'ocr',
  coingecko: 'other',
  other: 'other',
}

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
  'kimi-for-coding': 'Kimi for Coding',
  deepl: 'DeepL',
  'google-translate': 'Google Translate',
  'google-translate-free': 'Google Translate (Free)',
  'microsoft-translate': 'Microsoft Translator',
  'apple-translate': 'Apple Translate (macOS)',
  tavily: 'Tavily',
  serpapi: 'SerpAPI',
  'ocr-space': 'OCR.Space',
  'apple-ocr': 'Apple OCR (macOS)',
  paddleocr: 'PaddleOCR',
  coingecko: 'CoinGecko',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  amp: 'Amp',
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
  'kimi-for-coding': '#f97316',
  deepl: '#0f52ba',
  'google-translate': '#2563eb',
  'google-translate-free': '#1d4ed8',
  'microsoft-translate': '#2563eb',
  'apple-translate': '#111827',
  tavily: '#0891b2',
  serpapi: '#0284c7',
  'ocr-space': '#7c3aed',
  'apple-ocr': '#1f2937',
  paddleocr: '#0ea5e9',
  coingecko: '#16a34a',
  cursor: '#2563eb',
  opencode: '#0f766e',
  openclaw: '#b45309',
  amp: '#f34e3f',
  other: '#6b7280',
}

export function getProviderDisplayName(providerId: string): string {
  return PROVIDER_LABELS[providerId] || providerId
}

export function getProviderColor(providerId: string): string {
  return PROVIDER_COLORS[providerId] || '#999'
}

export function getProviderCategory(providerId: string): ProviderCategory {
  return PROVIDER_CATEGORIES[providerId] || 'other'
}

export function getProviderCategoryLabel(category: ProviderCategory): string {
  return PROVIDER_CATEGORY_LABELS[category]
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

export function buildProviderSelectGroups(providers: ProviderConfig[]): Array<{
  category: ProviderCategory
  label: string
  options: Array<{ value: string; label: string }>
}> {
  const order: ProviderCategory[] = ['model', 'translation', 'search', 'ocr', 'other']
  const grouped = new Map<ProviderCategory, Array<{ value: string; label: string }>>()

  providers.forEach((provider) => {
    const category = getProviderCategory(provider.provider)
    const list = grouped.get(category) || []
    list.push({
      value: provider.provider,
      label: provider.label || getProviderDisplayName(provider.provider),
    })
    grouped.set(category, list)
  })

  return order
    .map((category) => {
      const options = (grouped.get(category) || []).sort((a, b) => a.label.localeCompare(b.label))
      return {
        category,
        label: getProviderCategoryLabel(category),
        options,
      }
    })
    .filter((item) => item.options.length > 0)
}
