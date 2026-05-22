import type { ProviderConfig } from '../types/provider'

export interface GatewayModelCatalogItem {
  app_type: string
  provider: string
  model: string
}

export interface ModelTestEntry {
  provider: string
  providerLabel: string
  models: string[]
}

export interface ModelTestSelection {
  provider: string
  model: string
}

export function buildModelUseLabel(selection: {
  providerLabel: string
  model: string
}): string {
  const providerLabel = selection.providerLabel.trim()
  const model = selection.model.trim()
  if (!providerLabel && !model) return '选择模型'
  if (!providerLabel) return `使用模型：${model}`
  if (!model) return `使用模型：${providerLabel}`
  return `使用模型：${providerLabel} / ${model}`
}

function appendModel(target: Set<string>, model: string | null | undefined) {
  const trimmed = (model || '').trim()
  if (trimmed) {
    target.add(trimmed)
  }
}

function providerDetailsModels(provider: ProviderConfig): string[] {
  return [
    provider.details?.test_model,
    provider.details?.main_model,
    provider.details?.reasoning_model,
    provider.details?.default_haiku_model,
    provider.details?.default_sonnet_model,
    provider.details?.default_opus_model,
  ].filter((item): item is string => Boolean(item))
}

export function buildModelTestEntries(
  providers: ProviderConfig[],
  catalog: GatewayModelCatalogItem[],
): ModelTestEntry[] {
  const byProvider = new Map<string, { providerLabel: string; models: Set<string> }>()

  providers
    .filter((provider) => provider.is_active)
    .forEach((provider) => {
      const providerId = provider.provider.trim()
      if (!providerId) return
      const entry = byProvider.get(providerId) || {
        providerLabel: provider.label?.trim() || providerId,
        models: new Set<string>(),
      }
      provider.models.forEach((model) => appendModel(entry.models, model))
      providerDetailsModels(provider).forEach((model) => appendModel(entry.models, model))
      byProvider.set(providerId, entry)
    })

  catalog.forEach((item) => {
    const providerId = item.provider.trim()
    if (!providerId) return
    const entry = byProvider.get(providerId) || {
      providerLabel: providerId,
      models: new Set<string>(),
    }
    appendModel(entry.models, item.model)
    byProvider.set(providerId, entry)
  })

  return Array.from(byProvider.entries())
    .map(([provider, entry]) => ({
      provider,
      providerLabel: entry.providerLabel,
      models: Array.from(entry.models).sort((a, b) => a.localeCompare(b)),
    }))
    .filter((entry) => entry.models.length > 0)
    .sort((a, b) => a.providerLabel.localeCompare(b.providerLabel))
}

export function resolveInitialModelTestSelection(
  entries: ModelTestEntry[],
  current: ModelTestSelection,
): ModelTestSelection {
  const selectedEntry = entries.find((entry) => entry.provider === current.provider)
  if (selectedEntry?.models.includes(current.model)) {
    return current
  }

  const first = entries[0]
  return {
    provider: first?.provider || '',
    model: first?.models[0] || '',
  }
}
