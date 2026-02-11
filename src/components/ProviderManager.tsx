import { useEffect, useMemo, useState } from 'react'
import './ProviderManager.css'
import {
  ProviderConfig,
  ProviderEnvVar,
} from '../types/provider'
import { getProviderColor } from '../utils/provider'
import type { Project } from '../types/project'
import { buildProviderContext } from '../utils/linkage'

interface ProviderManagerProps {
  providers: ProviderConfig[]
  selectedProvider: ProviderConfig | null
  onSelectProvider: (provider: ProviderConfig) => void
  onSaveProvider: (
    provider: string,
    apiKey: string,
    baseUrl: string,
    models: string[]
  ) => Promise<void> | void
  credentials: { id: string; provider: string; source?: string | null }[]
  projects: Project[]
  projectLabelsByCredential: Record<string, string>
  loading?: boolean
}

export default function ProviderManager({
  providers,
  selectedProvider,
  onSelectProvider,
  onSaveProvider,
  credentials,
  projects,
  projectLabelsByCredential,
  loading,
}: ProviderManagerProps) {
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [newModel, setNewModel] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle')

  const activeProvider = selectedProvider
  const endpoints = activeProvider?.endpoints ?? []
  const envVars = activeProvider?.env_vars ?? []
  const appBindings = activeProvider?.app_bindings ?? []
  const activeProviderContext = useMemo(() => {
    if (!activeProvider) return null
    return buildProviderContext(
      activeProvider.provider,
      credentials,
      projectLabelsByCredential,
      projects
    )
  }, [activeProvider, credentials, projectLabelsByCredential, projects])

  useEffect(() => {
    if (activeProvider) {
      setApiKey(activeProvider.api_key || '')
      setBaseUrl(activeProvider.base_url || '')
      setModels(activeProvider.models || [])
      setNewModel('')
      setShowKey(false)
      setStatus('idle')
    }
  }, [activeProvider])

  const dirty = useMemo(() => {
    if (!activeProvider) return false
    return (
      apiKey !== (activeProvider.api_key || '') ||
      baseUrl !== (activeProvider.base_url || '') ||
      models.join('|') !== (activeProvider.models || []).join('|')
    )
  }, [activeProvider, apiKey, baseUrl, models])

  useEffect(() => {
    if (status !== 'idle') {
      setStatus('idle')
    }
  }, [apiKey, baseUrl, models])

  const handleSave = async () => {
    if (!activeProvider || !dirty) return
    setSaving(true)
    setStatus('idle')
    try {
      await onSaveProvider(activeProvider.provider, apiKey.trim(), baseUrl.trim(), models)
      setStatus('saved')
    } catch (error) {
      console.error(error)
      setStatus('error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="providers-view">
      <section className="panel provider-list-panel">
        <div className="panel-header">
          <h2>模型提供商</h2>
          <span className="panel-count">{providers.length}</span>
        </div>
        {loading ? (
          <div className="panel-loading">加载中...</div>
        ) : (
          <div className="provider-list">
            {providers.map((provider) => (
              <button
                key={provider.provider}
                className={`provider-row ${
                  activeProvider?.provider === provider.provider ? 'active' : ''
                }`}
                onClick={() => onSelectProvider(provider)}
              >
                <div
                  className="provider-avatar"
                  style={{ background: getProviderColor(provider.provider) }}
                >
                  {provider.label.slice(0, 1)}
                </div>
                <div className="provider-meta">
                  <div className="provider-name">{provider.label}</div>
                  <div className={`provider-status ${provider.api_key ? 'ready' : 'empty'}`}>
                    {provider.api_key ? '已配置' : '未配置'}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="panel provider-detail-panel">
        <div className="panel-header">
          <h2>配置详情</h2>
        </div>
        {activeProvider ? (
          <div className="provider-details">
            <div className="provider-title">
              <div className="provider-badge" style={{ background: getProviderColor(activeProvider.provider) }}>
                {activeProvider.label}
              </div>
              <div className="provider-updated">
                更新于 {new Date(activeProvider.updated_at).toLocaleString()}
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="provider-key">API Key</label>
              <div className="input-row">
                <input
                  id="provider-key"
                  type={showKey ? 'text' : 'password'}
                  placeholder="输入 API Key"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-link"
                  onClick={() => setShowKey(!showKey)}
                >
                  {showKey ? '隐藏' : '显示'}
                </button>
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="provider-base">API Base URL</label>
              <input
                id="provider-base"
                type="text"
                placeholder={getBasePlaceholder(activeProvider.provider)}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </div>

            <div className="form-group">
              <label>模型列表</label>
              <div className="model-input-row">
                <input
                  type="text"
                  placeholder="输入模型名称，例如 gpt-4o-mini"
                  value={newModel}
                  onChange={(e) => setNewModel(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    const value = newModel.trim()
                    if (!value) return
                    if (models.includes(value)) {
                      setNewModel('')
                      return
                    }
                    setModels((prev) => [...prev, value])
                    setNewModel('')
                  }}
                >
                  + 添加
                </button>
              </div>
              {models.length === 0 ? (
                <div className="helper-text">尚未录入模型名称。</div>
              ) : (
                <div className="model-tags">
                  {models.map((model) => (
                    <span key={model} className="model-tag">
                      {model}
                      <button
                        type="button"
                        onClick={() => setModels((prev) => prev.filter((item) => item !== model))}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="form-group">
              <label>使用路径</label>
              {activeProviderContext ? (
                <div className="helper-text">
                  密钥 {activeProviderContext.keyCount} · 项目 {activeProviderContext.projectCount} · 路径 {activeProviderContext.pathCount}
                </div>
              ) : null}
              <div className="usage-list">
                {collectUsagePaths(activeProvider.provider, credentials, projectLabelsByCredential, projects).length === 0 ? (
                  <div className="helper-text">暂无关联的文件路径。</div>
                ) : (
                  collectUsagePaths(activeProvider.provider, credentials, projectLabelsByCredential, projects).map((path) => (
                    <div key={path} className="usage-item">
                      {path}
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="form-group">
              <label>高级配置</label>
              <div className="advanced-grid">
                <div className="advanced-card">
                  <div className="advanced-title">端点</div>
                  {endpoints.length === 0 ? (
                    <div className="helper-text">暂无端点配置。</div>
                  ) : (
                    <div className="advanced-list">
                      {endpoints.map((endpoint) => (
                        <div key={endpoint.id} className="endpoint-item">
                          <div className="endpoint-header">
                            <span
                              className={`endpoint-badge ${
                                endpoint.is_primary ? 'primary' : ''
                              }`}
                            >
                              {endpoint.is_primary ? '主端点' : '备用端点'}
                            </span>
                            <span className="endpoint-url">{endpoint.base_url}</span>
                          </div>
                          <div className="endpoint-meta">
                            <span>超时 {formatTimeout(endpoint.timeout_ms)}</span>
                            {endpoint.proxy_url && <span>代理 {endpoint.proxy_url}</span>}
                          </div>
                          {endpoint.headers && (
                            <div className="endpoint-meta">Headers {endpoint.headers}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="advanced-card">
                  <div className="advanced-title">环境变量</div>
                  {envVars.length === 0 ? (
                    <div className="helper-text">暂无环境变量。</div>
                  ) : (
                    <div className="advanced-list">
                      {envVars.map((envVar) => (
                        <div key={envVar.id} className="env-item">
                          <div className="env-key">{envVar.key}</div>
                          <div className="env-meta">
                            <span className={`env-tag ${envVar.is_secret ? 'secret' : 'plain'}`}>
                              {envVar.is_secret ? '密钥' : '明文'}
                            </span>
                            <span className="env-value">{renderEnvValue(envVar)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="advanced-card">
                  <div className="advanced-title">应用绑定</div>
                  {appBindings.length === 0 ? (
                    <div className="helper-text">暂无应用绑定。</div>
                  ) : (
                    <div className="advanced-list">
                      {appBindings.map((binding) => (
                        <div key={binding.id} className="binding-item">
                          <div className="binding-name">{binding.app_type}</div>
                          <div className="binding-meta">
                            <span className={`binding-tag ${binding.enabled ? 'on' : 'off'}`}>
                              {binding.enabled ? '已启用' : '未启用'}
                            </span>
                            <span className="binding-path">
                              {binding.config_path ? binding.config_path : '未配置路径'}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="provider-actions">
              <button
                className="btn btn-primary"
                onClick={handleSave}
                disabled={!dirty || saving}
              >
                {saving ? '保存中...' : '保存更改'}
              </button>
              {status === 'saved' && <span className="save-status success">已保存</span>}
              {status === 'error' && <span className="save-status error">保存失败</span>}
            </div>
          </div>
        ) : (
          <div className="panel-empty">
            <p>请选择一个提供商</p>
          </div>
        )}
      </section>
    </div>
  )
}

const getBasePlaceholder = (provider: string) => {
  if (provider === 'openai') {
    return 'https://api.openai.com/v1'
  }
  if (provider === 'azure-openai') {
    return 'https://{resource}.openai.azure.com'
  }
  return 'https://'
}

const collectUsagePaths = (
  provider: string,
  credentials: { id: string; provider: string; source?: string | null }[],
  projectLabelsByCredential: Record<string, string>,
  projects: Project[]
) => {
  return buildProviderContext(provider, credentials, projectLabelsByCredential, projects).paths
}

const formatTimeout = (timeoutMs?: number | null) => {
  if (!timeoutMs || timeoutMs <= 0) return '默认'
  return `${Math.round(timeoutMs / 1000)}s`
}

const renderEnvValue = (envVar: ProviderEnvVar) => {
  if (envVar.is_secret) {
    return envVar.value && envVar.value.trim() ? '已设置' : '未设置'
  }
  return envVar.value && envVar.value.trim() ? envVar.value : '未设置'
}
