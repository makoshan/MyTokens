import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './ApplicationManager.css'
import type { ProviderConfig } from '../types/provider'
import type { AppIntegration } from '../types/settings'
import type { AppRoute } from '../types/app'
import { buildProviderSelectGroups, getProviderDisplayName } from '../utils/provider'

interface ApplicationManagerProps {
  masterPassword: string
  providers: ProviderConfig[]
}

interface RouteDraft {
  provider: string
  model: string
}

interface IntegrationConfigSnapshot {
  app_type: string
  config_path: string
  config: unknown
}

interface GatewayAccessCredentials {
  app_type: string
  base_url: string
  api_key: string
  provider: string
  model?: string | null
}

interface AppConfigDraft {
  other: string
}

interface QuickProviderPreset {
  provider: string
  label: string
  model?: string
}

interface AppEntryDraft {
  id: string
  name: string
  content: string
}

type AppConfigTab = 'model' | 'mcp' | 'skill' | 'other'

const MANAGED_CONFIG_APPS = new Set(['opencode', 'openclaw', 'codex', 'claude-code'])
const QUICK_ROUTE_APPS = new Set(['opencode', 'openclaw'])

const APP_MODEL_HINTS: Record<string, string[]> = {
  opencode: ['gpt-5', 'gpt-4.1', 'claude-sonnet-4-20250514', 'kimi-k2-0905-preview'],
  openclaw: ['gpt-5', 'gpt-4.1', 'claude-sonnet-4-20250514', 'kimi-k2-0905-preview'],
  codex: ['gpt-5', 'gpt-4.1'],
  'claude-code': ['claude-sonnet-4-20250514', 'claude-3-5-sonnet'],
}

const APP_QUICK_PROVIDER_PRESETS: Record<string, QuickProviderPreset[]> = {
  'claude-code': [
    { provider: 'anthropic', label: 'Claude Official', model: 'claude-sonnet-4-20250514' },
    { provider: 'deepseek', label: 'DeepSeek', model: 'deepseek-chat' },
    { provider: 'glm', label: 'Zhipu GLM', model: 'glm-4.7' },
    { provider: 'kimi', label: 'Kimi', model: 'kimi-k2-0905-preview' },
  ],
  codex: [
    { provider: 'openai', label: 'OpenAI Official', model: 'gpt-5' },
    { provider: 'openrouter', label: 'OpenRouter', model: 'openrouter/auto' },
    { provider: 'deepseek', label: 'DeepSeek', model: 'deepseek-chat' },
    { provider: 'qwen', label: 'Qwen', model: 'qwen3-max' },
  ],
  opencode: [
    { provider: 'openai', label: 'OpenAI Official', model: 'gpt-5' },
    { provider: 'openrouter', label: 'OpenRouter', model: 'openrouter/auto' },
    { provider: 'deepseek', label: 'DeepSeek', model: 'deepseek-chat' },
    { provider: 'kimi', label: 'Kimi', model: 'kimi-k2-0905-preview' },
  ],
  openclaw: [
    { provider: 'openai', label: 'OpenAI Official', model: 'gpt-5' },
    { provider: 'openrouter', label: 'OpenRouter', model: 'openrouter/auto' },
    { provider: 'deepseek', label: 'DeepSeek', model: 'deepseek-chat' },
    { provider: 'glm', label: 'Zhipu GLM', model: 'glm-4.7' },
  ],
}

const APP_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
  github: 'GitHub Copilot',
  antigravity: 'Antigravity',
  'z.ai': 'Z.ai',
  amp: 'Amp',
  aws: 'AWS Bedrock',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function parseJsonObject(label: string, source: string): Record<string, unknown> {
  const parsed = JSON.parse(source)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON 对象`)
  }
  return parsed as Record<string, unknown>
}

function randomId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function resolveSkillKey(root: Record<string, unknown>): 'skill' | 'skills' {
  if ('skill' in root) return 'skill'
  return 'skills'
}

function resolveMcpKey(root: Record<string, unknown>): 'mcp' | 'mcpServers' | 'mcps' {
  if ('mcpServers' in root) return 'mcpServers'
  if ('mcps' in root) return 'mcps'
  return 'mcp'
}

function pickMcpObject(root: Record<string, unknown>): Record<string, unknown> {
  return asRecord(root.mcp ?? root.mcpServers ?? root.mcps)
}

function pickSkillObject(root: Record<string, unknown>): Record<string, unknown> {
  const base = asRecord(root.skill ?? root.skills)
  if ('entries' in base && Object.keys(asRecord(base.entries)).length > 0) {
    return asRecord(base.entries)
  }
  return base
}

function buildEntries(value: unknown): AppEntryDraft[] {
  return Object.entries(asRecord(value))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entryValue]) => ({
      id: randomId(),
      name,
      content: formatJson(entryValue),
    }))
}

function parseEntriesToObject(label: string, entries: AppEntryDraft[]): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  const seen = new Set<string>()
  for (const entry of entries) {
    const name = entry.name.trim()
    if (!name) throw new Error(`${label} 条目名称不能为空`)
    if (seen.has(name)) throw new Error(`${label} 条目名称重复: ${name}`)
    seen.add(name)
    const parsed = parseJsonObject(`${label} 条目 ${name}`, entry.content)
    next[name] = parsed
  }
  return next
}

function buildAppConfigDraft(config: unknown): AppConfigDraft {
  const root = asRecord(config)
  const other: Record<string, unknown> = {}
  Object.entries(root).forEach(([key, value]) => {
    if (key === '$schema' || key === 'provider' || key === 'model') return
    if (key === 'mcp' || key === 'mcpServers' || key === 'mcps') return
    if (key === 'skill' || key === 'skills') return
    other[key] = value
  })
  return { other: formatJson(other) }
}

function appLabel(appType: string): string {
  return APP_LABELS[appType] || appType
}

function isAppVisible(appType: string): boolean {
  return appType !== 'openai-compatible' && appType !== 'claude'
}

function fallbackProvider(appType: string): string {
  if (appType === 'claude-code') return 'anthropic'
  if (appType === 'gemini') return 'gemini'
  if (appType === 'github') return 'github-copilot'
  if (appType === 'antigravity') return 'antigravity'
  if (appType === 'z.ai') return 'zai'
  if (appType === 'amp') return 'amp'
  if (appType === 'aws') return 'bedrock'
  return 'openai'
}

function uniqueNonEmpty(items: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  items.forEach((item) => {
    const value = item.trim()
    if (!value || seen.has(value)) return
    seen.add(value)
    result.push(value)
  })
  return result
}

export default function ApplicationManager({ masterPassword, providers }: ApplicationManagerProps) {
  const [integrations, setIntegrations] = useState<AppIntegration[]>([])
  const [routes, setRoutes] = useState<AppRoute[]>([])
  const [drafts, setDrafts] = useState<Record<string, RouteDraft>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [appSnapshots, setAppSnapshots] = useState<Record<string, IntegrationConfigSnapshot>>({})
  const [appDrafts, setAppDrafts] = useState<Record<string, AppConfigDraft>>({})
  const [appMcpEntries, setAppMcpEntries] = useState<Record<string, AppEntryDraft[]>>({})
  const [appSkillEntries, setAppSkillEntries] = useState<Record<string, AppEntryDraft[]>>({})
  const [appSkillKeys, setAppSkillKeys] = useState<Record<string, 'skill' | 'skills'>>({})
  const [appTabByType, setAppTabByType] = useState<Record<string, AppConfigTab>>({})
  const [gatewayAccessByApp, setGatewayAccessByApp] = useState<Record<string, GatewayAccessCredentials>>({})

  const providerSelectGroups = useMemo(() => buildProviderSelectGroups(providers), [providers])
  const providerValueSet = useMemo(() => new Set(providers.map((item) => item.provider)), [providers])
  const routeByApp = useMemo(() => new Map(routes.map((route) => [route.app_type, route])), [routes])

  const loadManagedConfig = async (appType: string) => {
    const snapshot = await invoke<IntegrationConfigSnapshot>('get_integration_config_snapshot', {
      appType,
      masterPassword,
    })
    const root = asRecord(snapshot.config)
    return {
      snapshot,
      draft: buildAppConfigDraft(root),
      mcpEntries: buildEntries(pickMcpObject(root)),
      skillEntries: buildEntries(pickSkillObject(root)),
      skillKey: resolveSkillKey(root),
    }
  }

  const loadManagedConfigs = async (appTypes: string[]) => {
    const results = await Promise.all(
      appTypes.map(async (appType) => {
        try {
          const loaded = await loadManagedConfig(appType)
          return { appType, ...loaded }
        } catch (err) {
          console.error(`加载 ${appType} 配置失败`, err)
          return null
        }
      })
    )
    const snapshots: Record<string, IntegrationConfigSnapshot> = {}
    const draftsMap: Record<string, AppConfigDraft> = {}
    const mcpMap: Record<string, AppEntryDraft[]> = {}
    const skillMap: Record<string, AppEntryDraft[]> = {}
    const skillKeyMap: Record<string, 'skill' | 'skills'> = {}
    results.forEach((item) => {
      if (!item) return
      snapshots[item.appType] = item.snapshot
      draftsMap[item.appType] = item.draft
      mcpMap[item.appType] = item.mcpEntries
      skillMap[item.appType] = item.skillEntries
      skillKeyMap[item.appType] = item.skillKey
    })
    setAppSnapshots(snapshots)
    setAppDrafts(draftsMap)
    setAppMcpEntries(mcpMap)
    setAppSkillEntries(skillMap)
    setAppSkillKeys(skillKeyMap)
  }

  const loadData = async () => {
    if (!masterPassword) return
    setLoading(true)
    setError(null)
    try {
      const [settings, appRoutes] = await Promise.all([
        invoke<{ integrations: AppIntegration[] }>('get_global_settings', { masterPassword }),
        invoke<AppRoute[]>('get_app_routes', { masterPassword }),
      ])

      const visibleIntegrations = settings.integrations
        .filter((item) => isAppVisible(item.app_type))
        .sort((a, b) => appLabel(a.app_type).localeCompare(appLabel(b.app_type)))
      const visibleRoutes = appRoutes
        .filter((item) => isAppVisible(item.app_type))
        .sort((a, b) => appLabel(a.app_type).localeCompare(appLabel(b.app_type)))

      setIntegrations(visibleIntegrations)
      setRoutes(visibleRoutes)

      setDrafts((previous) => {
        const next = { ...previous }
        visibleIntegrations.forEach((integration) => {
          const route = visibleRoutes.find((item) => item.app_type === integration.app_type)
          if (!next[integration.app_type]) {
            next[integration.app_type] = {
              provider: route?.provider || fallbackProvider(integration.app_type),
              model: route?.model || '',
            }
          }
        })
        return next
      })

      const managedTypes = visibleIntegrations
        .map((item) => item.app_type)
        .filter((appType) => MANAGED_CONFIG_APPS.has(appType))
      await loadManagedConfigs(managedTypes)

      const gatewayApps = ['claude-code', 'codex'].filter((appType) =>
        visibleIntegrations.some((item) => item.app_type === appType)
      )
      const gatewayResults = await Promise.all(
        gatewayApps.map(async (appType) => {
          try {
            const creds = await invoke<GatewayAccessCredentials>('get_gateway_access_credentials', {
              appType,
              masterPassword,
            })
            return [appType, creds] as const
          } catch {
            return null
          }
        })
      )
      const gatewayMap: Record<string, GatewayAccessCredentials> = {}
      gatewayResults.forEach((item) => {
        if (!item) return
        gatewayMap[item[0]] = item[1]
      })
      setGatewayAccessByApp(gatewayMap)
    } catch (err) {
      console.error(err)
      setError('加载应用配置失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [masterPassword])

  const saveAppSection = async (appType: string, section: 'mcp' | 'skill' | 'other') => {
    const snapshot = appSnapshots[appType]
    const appDraft = appDrafts[appType]
    if (!snapshot || !appDraft) {
      alert(`${appLabel(appType)} 配置尚未加载完成`)
      return
    }

    let nextRoot = asRecord(snapshot.config)
    const mcpKey = resolveMcpKey(nextRoot)
    const skillKey = appSkillKeys[appType] || resolveSkillKey(nextRoot)

    try {
      if (section === 'mcp') {
        nextRoot = {
          ...nextRoot,
          [mcpKey]: parseEntriesToObject('MCP', appMcpEntries[appType] || []),
        }
      } else if (section === 'skill') {
        const hasEntriesEnvelope = 'entries' in asRecord(nextRoot[skillKey])
        nextRoot = {
          ...nextRoot,
          [skillKey]: hasEntriesEnvelope
            ? {
                ...asRecord(nextRoot[skillKey]),
                entries: parseEntriesToObject('Skills', appSkillEntries[appType] || []),
              }
            : parseEntriesToObject('Skills', appSkillEntries[appType] || []),
        }
        if (skillKey === 'skills') delete nextRoot.skill
        else delete nextRoot.skills
      } else {
        const parsedOther = parseJsonObject('其他配置', appDraft.other)
        const preserved: Record<string, unknown> = {}
        if ('$schema' in nextRoot) preserved.$schema = nextRoot.$schema
        if ('provider' in nextRoot) preserved.provider = nextRoot.provider
        if ('model' in nextRoot) preserved.model = nextRoot.model
        if (mcpKey in nextRoot) preserved[mcpKey] = nextRoot[mcpKey]
        if ('skill' in nextRoot) preserved.skill = nextRoot.skill
        if ('skills' in nextRoot) preserved.skills = nextRoot.skills
        nextRoot = { ...preserved, ...parsedOther }
      }
    } catch (err) {
      alert(String(err))
      return
    }

    setBusyKey(`${appType}-save:${section}`)
    try {
      await invoke('save_integration_config_snapshot', {
        appType,
        config: nextRoot,
        masterPassword,
      })
      const loaded = await loadManagedConfig(appType)
      setAppSnapshots((previous) => ({ ...previous, [appType]: loaded.snapshot }))
      setAppDrafts((previous) => ({ ...previous, [appType]: loaded.draft }))
      setAppMcpEntries((previous) => ({ ...previous, [appType]: loaded.mcpEntries }))
      setAppSkillEntries((previous) => ({ ...previous, [appType]: loaded.skillEntries }))
      setAppSkillKeys((previous) => ({ ...previous, [appType]: loaded.skillKey }))
      setNotice(`${appLabel(appType)} ${section === 'other' ? '其他配置' : section.toUpperCase()} 已保存`)
    } catch (err) {
      console.error(err)
      alert(`保存 ${appLabel(appType)} 配置失败: ${String(err)}`)
    } finally {
      setBusyKey(null)
    }
  }

  const refreshManagedConfig = async (appType: string) => {
    setBusyKey(`${appType}-refresh`)
    try {
      const loaded = await loadManagedConfig(appType)
      setAppSnapshots((previous) => ({ ...previous, [appType]: loaded.snapshot }))
      setAppDrafts((previous) => ({ ...previous, [appType]: loaded.draft }))
      setAppMcpEntries((previous) => ({ ...previous, [appType]: loaded.mcpEntries }))
      setAppSkillEntries((previous) => ({ ...previous, [appType]: loaded.skillEntries }))
      setAppSkillKeys((previous) => ({ ...previous, [appType]: loaded.skillKey }))
    } catch (err) {
      alert(`刷新配置失败: ${String(err)}`)
    } finally {
      setBusyKey(null)
    }
  }

  const openPath = async (path: string) => {
    setBusyKey(`open:${path}`)
    try {
      await invoke('open_path', { path })
    } catch (err) {
      console.error(err)
      alert(`打开路径失败: ${String(err)}`)
    } finally {
      setBusyKey(null)
    }
  }

  const updateIntegrationEnabled = async (appType: string, enabled: boolean) => {
    setBusyKey(`integration:${appType}`)
    setNotice(null)
    try {
      await invoke('set_global_integration_enabled', { appType, enabled, masterPassword })
      await loadData()
    } catch (err) {
      console.error(err)
      alert(`更新应用开关失败: ${String(err)}`)
    } finally {
      setBusyKey(null)
    }
  }

  const saveRoute = async (appType: string) => {
    const draft = drafts[appType]
    if (!draft?.provider) {
      alert('请选择一个提供商')
      return
    }
    await saveRouteByDraft(appType, draft.provider, draft.model)
  }

  const saveRouteByDraft = async (appType: string, provider: string, modelDraft: string) => {
    setBusyKey(`route:${appType}`)
    setNotice(null)
    try {
      const saved = await invoke<AppRoute>('set_app_route', {
        appType,
        provider,
        model: modelDraft.trim() ? modelDraft.trim() : null,
        masterPassword,
      })
      setRoutes((previous) => {
        const next = previous.filter((item) => item.app_type !== appType)
        next.push(saved)
        next.sort((a, b) => appLabel(a.app_type).localeCompare(appLabel(b.app_type)))
        return next
      })
      setDrafts((previous) => ({
        ...previous,
        [appType]: {
          provider,
          model: modelDraft,
        },
      }))
      if (appType === 'claude-code') setNotice('已保存并同步 Claude Code 配置')
      else if (appType === 'opencode') setNotice('已保存并同步 OpenCode 配置')
      else if (appType === 'openclaw') setNotice('已保存并同步 OpenClaw 配置')
      else if (appType === 'codex') setNotice('已保存并同步 Codex 配置')
      else setNotice('路由已保存')
    } catch (err) {
      console.error(err)
      setNotice(null)
      alert(`保存应用路由失败: ${String(err)}`)
    } finally {
      setBusyKey(null)
    }
  }

  const applyQuickProviderPreset = async (appType: string, preset: QuickProviderPreset) => {
    const available = providers.some((item) => item.provider === preset.provider)
    if (!available) {
      alert(`未找到 ${preset.label}，请先在“提供商”页创建 ${preset.provider}`)
      return
    }
    const model = preset.model || drafts[appType]?.model || ''
    await saveRouteByDraft(appType, preset.provider, model)
  }

  const importRouteFromLive = async (appType: string) => {
    setBusyKey(`route-import:${appType}`)
    setNotice(null)
    try {
      const detected = await invoke<AppRoute | null>('detect_app_route_from_live_config', {
        appType,
        masterPassword,
      })
      if (!detected) {
        setNotice(`${appLabel(appType)} 未检测到可导入的本地供应商路由`)
        return
      }
      setDrafts((previous) => ({
        ...previous,
        [appType]: {
          provider: detected.provider,
          model: detected.model || '',
        },
      }))
      setNotice(
        `${appLabel(appType)} 已从本地配置导入: ${getProviderDisplayName(detected.provider)}${
          detected.model ? ` · ${detected.model}` : ''
        }（点击“保存路由”生效）`
      )
    } catch (err) {
      console.error(err)
      setNotice(null)
      alert(`导入本地配置失败: ${String(err)}`)
    } finally {
      setBusyKey(null)
    }
  }

  if (loading) {
    return (
      <section className="panel app-manager-empty">
        <p>加载应用配置中...</p>
      </section>
    )
  }

  if (error) {
    return (
      <section className="panel app-manager-empty">
        <p>{error}</p>
        <button className="btn btn-primary" onClick={loadData}>
          重新加载
        </button>
      </section>
    )
  }

  return (
    <section className="panel app-manager-panel">
      <div className="panel-header">
        <h2>应用路由</h2>
        <span className="panel-count">{integrations.length}</span>
      </div>
      {notice ? <div className="app-manager-notice">{notice}</div> : null}
      <div className="app-manager-list">
        {integrations.map((integration) => {
          const appType = integration.app_type
          const draft = drafts[appType] || {
            provider: routeByApp.get(appType)?.provider || fallbackProvider(appType),
            model: routeByApp.get(appType)?.model || '',
          }
          const currentRoute = routeByApp.get(appType)
          const selectedProvider = providers.find((provider) => provider.provider === draft.provider) || null
          const modelOptions = selectedProvider?.models || []
          const quickModelOptions = uniqueNonEmpty([
            ...modelOptions.slice(0, 10),
            ...(APP_MODEL_HINTS[appType] || []),
            draft.model,
            currentRoute?.model || '',
          ]).slice(0, 10)
          const quickProviderPresets = APP_QUICK_PROVIDER_PRESETS[appType] || []

          const saving = busyKey === `route:${appType}`
          const importing = busyKey === `route-import:${appType}`
          const toggling = busyKey === `integration:${appType}`
          const isManaged = MANAGED_CONFIG_APPS.has(appType)
          const activeTab: AppConfigTab = appTabByType[appType] || 'model'
          const snapshot = appSnapshots[appType]
          const appDraft = appDrafts[appType]
          const mcpEntries = appMcpEntries[appType] || []
          const skillEntries = appSkillEntries[appType] || []
          const otherRoot = asRecord(snapshot?.config)
          const otherCount = Object.keys(
            asRecord(
              Object.fromEntries(
                Object.entries(otherRoot).filter(([key]) => {
                  if (key === '$schema' || key === 'provider' || key === 'model') return false
                  if (key === 'mcp' || key === 'mcpServers' || key === 'mcps') return false
                  if (key === 'skill' || key === 'skills') return false
                  return true
                })
              )
            )
          ).length

          return (
            <article key={appType} className="app-manager-item">
              <div className="app-manager-head">
                <div>
                  <div className="app-manager-title">{appLabel(appType)}</div>
                  <div className="app-manager-subtitle">{integration.config_path || '无默认配置路径'}</div>
                </div>
                <div className="app-manager-badges">
                  <span className={`app-manager-badge ${integration.detected ? 'running' : 'stopped'}`}>
                    {integration.detected ? '已检测' : '未检测'}
                  </span>
                  <span className={`app-manager-badge ${integration.enabled ? 'enabled' : 'disabled'}`}>
                    {integration.enabled ? '已启用' : '未启用'}
                  </span>
                </div>
              </div>

              {isManaged ? (
                <div className="app-manager-tab-row">
                  <button
                    type="button"
                    className={`app-manager-tab ${activeTab === 'model' ? 'active' : ''}`}
                    onClick={() => setAppTabByType((prev) => ({ ...prev, [appType]: 'model' }))}
                  >
                    模型
                  </button>
                  <button
                    type="button"
                    className={`app-manager-tab ${activeTab === 'mcp' ? 'active' : ''}`}
                    onClick={() => setAppTabByType((prev) => ({ ...prev, [appType]: 'mcp' }))}
                  >
                    MCP ({mcpEntries.length})
                  </button>
                  <button
                    type="button"
                    className={`app-manager-tab ${activeTab === 'skill' ? 'active' : ''}`}
                    onClick={() => setAppTabByType((prev) => ({ ...prev, [appType]: 'skill' }))}
                  >
                    Skills ({skillEntries.length})
                  </button>
                  <button
                    type="button"
                    className={`app-manager-tab ${activeTab === 'other' ? 'active' : ''}`}
                    onClick={() => setAppTabByType((prev) => ({ ...prev, [appType]: 'other' }))}
                  >
                    其他 ({otherCount})
                  </button>
                </div>
              ) : null}

              {(!isManaged || activeTab === 'model') && (
                <>
                  {(appType === 'claude-code' || appType === 'codex') && gatewayAccessByApp[appType] ? (
                    <div className="app-manager-notice app-manager-gateway-notice">
                      Gateway API: <code>{gatewayAccessByApp[appType].base_url}</code> · Key:{' '}
                      <code>{gatewayAccessByApp[appType].api_key}</code>
                    </div>
                  ) : null}
                  <div className="app-manager-controls">
                    <div className="app-manager-field">
                      <label>提供商</label>
                      <select
                        value={draft.provider}
                        onChange={(event) =>
                          setDrafts((previous) => ({
                            ...previous,
                            [appType]: { ...draft, provider: event.target.value },
                          }))
                        }
                      >
                        {!providerValueSet.has(draft.provider) ? (
                          <option value={draft.provider}>{draft.provider}</option>
                        ) : null}
                        {providerSelectGroups.map((group) => (
                          <optgroup key={group.category} label={group.label}>
                            {group.options.map((provider) => (
                              <option key={provider.value} value={provider.value}>
                                {provider.label}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </div>

                    <div className="app-manager-field">
                      <label>模型</label>
                      <div className="app-manager-model-row">
                        <select
                          value={modelOptions.includes(draft.model) ? draft.model : ''}
                          onChange={(event) =>
                            setDrafts((previous) => ({
                              ...previous,
                              [appType]: { ...draft, model: event.target.value },
                            }))
                          }
                        >
                          <option value="">默认</option>
                          {modelOptions.map((model) => (
                            <option key={model} value={model}>
                              {model}
                            </option>
                          ))}
                        </select>
                        <input
                          type="text"
                          value={draft.model}
                          placeholder={
                            QUICK_ROUTE_APPS.has(appType)
                              ? '模型（支持快捷选择或手动输入）'
                              : '自定义模型（可选）'
                          }
                          onChange={(event) =>
                            setDrafts((previous) => ({
                              ...previous,
                              [appType]: { ...draft, model: event.target.value },
                            }))
                          }
                        />
                      </div>
                      {QUICK_ROUTE_APPS.has(appType) ? (
                        <div className="app-manager-model-chips">
                          {quickModelOptions.length === 0 ? (
                            <span className="app-manager-chip-hint">先在提供商里配置可用模型</span>
                          ) : (
                            quickModelOptions.map((model) => (
                              <button
                                key={`${appType}:${model}`}
                                type="button"
                                className={`app-manager-model-chip ${draft.model === model ? 'active' : ''}`}
                                onClick={() =>
                                  setDrafts((previous) => ({
                                    ...previous,
                                    [appType]: { ...draft, model },
                                  }))
                                }
                              >
                                {model}
                              </button>
                            ))
                          )}
                        </div>
                      ) : null}
                    </div>
                  </div>

                  {quickProviderPresets.length > 0 ? (
                    <div className="app-manager-preset-box">
                      <div className="app-manager-preset-title">快捷供应商导入（参考 CC Switch）</div>
                      <div className="app-manager-preset-list">
                        {quickProviderPresets.map((preset) => {
                          const isActiveProvider = draft.provider === preset.provider
                          const isApplying = busyKey === `route:${appType}`
                          return (
                            <button
                              key={`${appType}:${preset.provider}`}
                              type="button"
                              className={`app-manager-preset-chip ${isActiveProvider ? 'active' : ''}`}
                              disabled={isApplying}
                              onClick={() => applyQuickProviderPreset(appType, preset)}
                              title={preset.model ? `默认模型: ${preset.model}` : undefined}
                            >
                              {preset.label}
                              {preset.model ? <span>{preset.model}</span> : null}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ) : null}

                  <div className="app-manager-actions">
                    <button
                      className="btn btn-secondary"
                      disabled={importing || saving}
                      onClick={() => importRouteFromLive(appType)}
                    >
                      {importing ? '导入中...' : '从本地配置导入'}
                    </button>
                    <button
                      className={`btn ${integration.enabled ? 'btn-secondary' : 'btn-primary'}`}
                      disabled={toggling}
                      onClick={() => updateIntegrationEnabled(appType, !integration.enabled)}
                    >
                      {integration.enabled ? '停用集成' : '启用集成'}
                    </button>
                    <button className="btn btn-primary" disabled={saving} onClick={() => saveRoute(appType)}>
                      {saving ? '保存中...' : '保存路由'}
                    </button>
                    {currentRoute ? (
                      <span className="app-manager-updated">
                        当前: {getProviderDisplayName(currentRoute.provider)}
                        {currentRoute.model ? ` · ${currentRoute.model}` : ''}
                      </span>
                    ) : null}
                  </div>
                </>
              )}

              {isManaged && activeTab !== 'model' && appDraft ? (
                <div className="app-manager-tab-panel">
                  <div className="app-manager-tab-actions">
                    <button
                      className="btn btn-secondary"
                      disabled={busyKey === `${appType}-refresh`}
                      onClick={() => refreshManagedConfig(appType)}
                    >
                      刷新配置
                    </button>
                    {snapshot?.config_path ? (
                      <button
                        className="btn btn-secondary"
                        disabled={busyKey === `open:${snapshot.config_path}`}
                        onClick={() => openPath(snapshot.config_path)}
                      >
                        打开配置文件
                      </button>
                    ) : null}
                  </div>

                  {activeTab === 'mcp' ? (
                    <div className="app-manager-json-editor">
                      <div className="app-manager-tool-list">
                        {mcpEntries.length === 0 ? (
                          <div className="app-manager-tool-empty">还没有 MCP 条目</div>
                        ) : (
                          mcpEntries.map((entry) => (
                            <article key={entry.id} className="app-manager-tool-item">
                              <div className="app-manager-tool-row">
                                <input
                                  type="text"
                                  value={entry.name}
                                  placeholder="MCP 名称"
                                  onChange={(event) =>
                                    setAppMcpEntries((previous) => ({
                                      ...previous,
                                      [appType]: (previous[appType] || []).map((item) =>
                                        item.id === entry.id ? { ...item, name: event.target.value } : item
                                      ),
                                    }))
                                  }
                                />
                                <button
                                  className="btn btn-secondary"
                                  onClick={() =>
                                    setAppMcpEntries((previous) => ({
                                      ...previous,
                                      [appType]: (previous[appType] || []).filter((item) => item.id !== entry.id),
                                    }))
                                  }
                                >
                                  删除
                                </button>
                              </div>
                              <textarea
                                value={entry.content}
                                onChange={(event) =>
                                  setAppMcpEntries((previous) => ({
                                    ...previous,
                                    [appType]: (previous[appType] || []).map((item) =>
                                      item.id === entry.id ? { ...item, content: event.target.value } : item
                                    ),
                                  }))
                                }
                              />
                            </article>
                          ))
                        )}
                      </div>
                      <button
                        className="btn btn-secondary"
                        onClick={() =>
                          setAppMcpEntries((previous) => ({
                            ...previous,
                            [appType]: [
                              ...(previous[appType] || []),
                              { id: randomId(), name: '', content: formatJson({ command: '' }) },
                            ],
                          }))
                        }
                      >
                        + 新增 MCP
                      </button>
                      <button
                        className="btn btn-primary"
                        disabled={busyKey === `${appType}-save:mcp`}
                        onClick={() => saveAppSection(appType, 'mcp')}
                      >
                        保存 MCP
                      </button>
                    </div>
                  ) : null}

                  {activeTab === 'skill' ? (
                    <div className="app-manager-json-editor">
                      <div className="app-manager-tool-list">
                        {skillEntries.length === 0 ? (
                          <div className="app-manager-tool-empty">还没有 Skill 条目</div>
                        ) : (
                          skillEntries.map((entry) => (
                            <article key={entry.id} className="app-manager-tool-item">
                              <div className="app-manager-tool-row">
                                <input
                                  type="text"
                                  value={entry.name}
                                  placeholder="Skill 名称"
                                  onChange={(event) =>
                                    setAppSkillEntries((previous) => ({
                                      ...previous,
                                      [appType]: (previous[appType] || []).map((item) =>
                                        item.id === entry.id ? { ...item, name: event.target.value } : item
                                      ),
                                    }))
                                  }
                                />
                                <button
                                  className="btn btn-secondary"
                                  onClick={() =>
                                    setAppSkillEntries((previous) => ({
                                      ...previous,
                                      [appType]: (previous[appType] || []).filter((item) => item.id !== entry.id),
                                    }))
                                  }
                                >
                                  删除
                                </button>
                              </div>
                              <textarea
                                value={entry.content}
                                onChange={(event) =>
                                  setAppSkillEntries((previous) => ({
                                    ...previous,
                                    [appType]: (previous[appType] || []).map((item) =>
                                      item.id === entry.id ? { ...item, content: event.target.value } : item
                                    ),
                                  }))
                                }
                              />
                            </article>
                          ))
                        )}
                      </div>
                      <button
                        className="btn btn-secondary"
                        onClick={() =>
                          setAppSkillEntries((previous) => ({
                            ...previous,
                            [appType]: [
                              ...(previous[appType] || []),
                              { id: randomId(), name: '', content: formatJson({ description: '' }) },
                            ],
                          }))
                        }
                      >
                        + 新增 Skill
                      </button>
                      <button
                        className="btn btn-primary"
                        disabled={busyKey === `${appType}-save:skill`}
                        onClick={() => saveAppSection(appType, 'skill')}
                      >
                        保存 Skills
                      </button>
                    </div>
                  ) : null}

                  {activeTab === 'other' ? (
                    <div className="app-manager-json-editor">
                      <label>其他顶层配置 JSON（对象）</label>
                      <textarea
                        value={appDraft.other}
                        onChange={(event) =>
                          setAppDrafts((previous) => ({
                            ...previous,
                            [appType]: { other: event.target.value },
                          }))
                        }
                      />
                      <button
                        className="btn btn-primary"
                        disabled={busyKey === `${appType}-save:other`}
                        onClick={() => saveAppSection(appType, 'other')}
                      >
                        保存其他配置
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </article>
          )
        })}
      </div>
    </section>
  )
}
