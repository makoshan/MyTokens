import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './ApplicationManager.css'
import type { ProviderConfig } from '../types/provider'
import type { AppIntegration } from '../types/settings'
import type { AppRoute } from '../types/app'
import { getProviderDisplayName } from '../utils/provider'

interface ApplicationManagerProps {
  masterPassword: string
  providers: ProviderConfig[]
}

interface RouteDraft {
  provider: string
  model: string
}

const APP_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
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
  return 'openai'
}

export default function ApplicationManager({ masterPassword, providers }: ApplicationManagerProps) {
  const [integrations, setIntegrations] = useState<AppIntegration[]>([])
  const [routes, setRoutes] = useState<AppRoute[]>([])
  const [drafts, setDrafts] = useState<Record<string, RouteDraft>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const providerOptions = useMemo(() => {
    return [...providers].sort((a, b) => a.label.localeCompare(b.label))
  }, [providers])

  const routeByApp = useMemo(() => {
    return new Map(routes.map((route) => [route.app_type, route]))
  }, [routes])

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
    setBusyKey(`route:${appType}`)
    setNotice(null)
    try {
      const saved = await invoke<AppRoute>('set_app_route', {
        appType,
        provider: draft.provider,
        model: draft.model.trim() ? draft.model.trim() : null,
        masterPassword,
      })
      setRoutes((previous) => {
        const next = previous.filter((item) => item.app_type !== appType)
        next.push(saved)
        next.sort((a, b) => appLabel(a.app_type).localeCompare(appLabel(b.app_type)))
        return next
      })
      setNotice(appType === 'claude-code' ? '已保存并同步 Claude Code 配置' : '路由已保存')
    } catch (err) {
      console.error(err)
      setNotice(null)
      alert(`保存应用路由失败: ${String(err)}`)
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
          const selectedProvider =
            providerOptions.find((provider) => provider.provider === draft.provider) || null
          const modelOptions = selectedProvider?.models || []
          const saving = busyKey === `route:${appType}`
          const toggling = busyKey === `integration:${appType}`

          return (
            <article key={appType} className="app-manager-item">
              <div className="app-manager-head">
                <div>
                  <div className="app-manager-title">{appLabel(appType)}</div>
                  <div className="app-manager-subtitle">
                    {integration.config_path || '无默认配置路径'}
                  </div>
                </div>
                <div className="app-manager-badges">
                  <span
                    className={`app-manager-badge ${integration.detected ? 'running' : 'stopped'}`}
                  >
                    {integration.detected ? '已检测' : '未检测'}
                  </span>
                  <span
                    className={`app-manager-badge ${integration.enabled ? 'enabled' : 'disabled'}`}
                  >
                    {integration.enabled ? '已启用' : '未启用'}
                  </span>
                </div>
              </div>

              <div className="app-manager-controls">
                <div className="app-manager-field">
                  <label>提供商</label>
                  <select
                    value={draft.provider}
                    onChange={(event) =>
                      setDrafts((previous) => ({
                        ...previous,
                        [appType]: {
                          ...draft,
                          provider: event.target.value,
                        },
                      }))
                    }
                  >
                    {providerOptions.map((provider) => (
                      <option key={provider.provider} value={provider.provider}>
                        {provider.label || getProviderDisplayName(provider.provider)}
                      </option>
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
                          [appType]: {
                            ...draft,
                            model: event.target.value,
                          },
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
                      placeholder="自定义模型（可选）"
                      onChange={(event) =>
                        setDrafts((previous) => ({
                          ...previous,
                          [appType]: {
                            ...draft,
                            model: event.target.value,
                          },
                        }))
                      }
                    />
                  </div>
                </div>
              </div>

              <div className="app-manager-actions">
                <button
                  className={`btn ${integration.enabled ? 'btn-secondary' : 'btn-primary'}`}
                  disabled={toggling}
                  onClick={() => updateIntegrationEnabled(appType, !integration.enabled)}
                >
                  {integration.enabled ? '停用集成' : '启用集成'}
                </button>
                <button
                  className="btn btn-primary"
                  disabled={saving}
                  onClick={() => saveRoute(appType)}
                >
                  {saving ? '保存中...' : '保存路由'}
                </button>
                {currentRoute ? (
                  <span className="app-manager-updated">
                    当前: {getProviderDisplayName(currentRoute.provider)}
                    {currentRoute.model ? ` · ${currentRoute.model}` : ''}
                  </span>
                ) : null}
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
