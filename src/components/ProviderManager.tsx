import { useEffect, useMemo, useState } from 'react'
import './ProviderManager.css'
import {
  ProviderConfig,
  ProviderEnvVar,
} from '../types/provider'
import {
  getProviderCategory,
  getProviderCategoryLabel,
  getProviderColor,
  type ProviderCategory,
} from '../utils/provider'
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
  onToggleProviderActive: (provider: string, isActive: boolean) => Promise<void> | void
  onDeleteProvider: (provider: string) => Promise<void> | void
  credentials: { id: string; provider: string; source?: string | null }[]
  projects: Project[]
  projectLabelsByCredential: Record<string, string>
  loading?: boolean
}

const CATEGORY_ORDER: ProviderCategory[] = ['model', 'translation', 'search', 'ocr', 'other']

export default function ProviderManager({
  providers,
  selectedProvider,
  onSelectProvider,
  onSaveProvider,
  onToggleProviderActive,
  onDeleteProvider,
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
  const [togglingProvider, setTogglingProvider] = useState<string | null>(null)
  const [deletingProvider, setDeletingProvider] = useState<string | null>(null)
  const [showCreateProviderForm, setShowCreateProviderForm] = useState(false)
  const [newProviderId, setNewProviderId] = useState('')
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [categoryFilter, setCategoryFilter] = useState<ProviderCategory | 'all'>('all')
  const [showAdvanced, setShowAdvanced] = useState(false)

  const activeProvider = selectedProvider
  const activeCategory = activeProvider ? getProviderCategory(activeProvider.provider) : null
  const endpoints = activeProvider?.endpoints ?? []
  const envVars = activeProvider?.env_vars ?? []
  const appBindings = activeProvider?.app_bindings ?? []
  const formProfile = useMemo(() => getFormProfile(activeCategory), [activeCategory])
  const showEmptyAdvancedCards = activeCategory === 'model'
  const visibleAdvancedCards = useMemo(() => {
    return [
      { id: 'endpoints', title: '端点', count: endpoints.length },
      { id: 'env', title: '环境变量', count: envVars.length },
      { id: 'bindings', title: '应用绑定', count: appBindings.length },
    ].filter((item) => showEmptyAdvancedCards || item.count > 0)
  }, [appBindings.length, endpoints.length, envVars.length, showEmptyAdvancedCards])
  const activeProviderContext = useMemo(() => {
    if (!activeProvider) return null
    return buildProviderContext(
      activeProvider.provider,
      credentials,
      projectLabelsByCredential,
      projects
    )
  }, [activeProvider, credentials, projectLabelsByCredential, projects])

  const providerGroups = useMemo(() => {
    const grouped = new Map<ProviderCategory, ProviderConfig[]>()
    providers.forEach((provider) => {
      const category = getProviderCategory(provider.provider)
      const list = grouped.get(category) || []
      list.push(provider)
      grouped.set(category, list)
    })
    CATEGORY_ORDER.forEach((category) => {
      const list = grouped.get(category)
      if (list) {
        list.sort((a, b) => a.label.localeCompare(b.label))
      }
    })
    return grouped
  }, [providers])

  const visibleCategories = useMemo(() => {
    if (categoryFilter === 'all') {
      return CATEGORY_ORDER.filter((category) => (providerGroups.get(category)?.length || 0) > 0)
    }
    return (providerGroups.get(categoryFilter)?.length || 0) > 0 ? [categoryFilter] : []
  }, [categoryFilter, providerGroups])
  useEffect(() => {
    if (activeProvider) {
      setApiKey(activeProvider.api_key || '')
      setBaseUrl(activeProvider.base_url || '')
      setModels(activeProvider.models || [])
      setNewModel('')
      setShowKey(false)
      setStatus('idle')
      setShowAdvanced(getProviderCategory(activeProvider.provider) === 'model')
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

  const handleToggleProvider = async (providerId: string, isActive: boolean) => {
    setTogglingProvider(providerId)
    try {
      await onToggleProviderActive(providerId, isActive)
    } catch (error) {
      console.error(error)
    } finally {
      setTogglingProvider(null)
    }
  }

  const handleQuickAddProvider = async () => {
    const normalized = newProviderId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '')
    if (!normalized) {
      alert('服务 ID 无效')
      return
    }

    const existing = providers.find((item) => item.provider === normalized)
    if (existing) {
      onSelectProvider(existing)
      alert('该服务已存在，已为你切换到该服务。')
      return
    }

    await onSaveProvider(normalized, '', '', [])
    setShowCreateProviderForm(false)
    setNewProviderId('')
  }

  const handleDeleteCurrentProvider = async () => {
    if (!activeProvider) return
    if (!confirm(`确定删除服务 ${activeProvider.label} 吗？`)) return
    setDeletingProvider(activeProvider.provider)
    try {
      await onDeleteProvider(activeProvider.provider)
    } catch (error) {
      console.error(error)
    } finally {
      setDeletingProvider(null)
    }
  }

  return (
    <div className="providers-view">
      <section className="panel provider-list-panel">
        <div className="panel-header">
          <h2>供应商</h2>
          <span className="panel-count">{providers.length}</span>
        </div>
        <div className="provider-segments">
          <button
            type="button"
            className={`provider-segment ${categoryFilter === 'all' ? 'active' : ''}`}
            onClick={() => setCategoryFilter('all')}
          >
            全部
            <span>{providers.length}</span>
          </button>
          {CATEGORY_ORDER.map((category) => {
            const count = providerGroups.get(category)?.length || 0
            if (count === 0) return null
            return (
              <button
                key={category}
                type="button"
                className={`provider-segment ${categoryFilter === category ? 'active' : ''}`}
                onClick={() => setCategoryFilter(category)}
              >
                {getProviderCategoryLabel(category)}
                <span>{count}</span>
              </button>
            )
          })}
        </div>
        {loading ? (
          <div className="panel-loading">加载中...</div>
        ) : (
          <div className="provider-list">
            {visibleCategories.map((category) => (
              <div key={category} className="provider-group">
                <div className="provider-group-title">
                  {getProviderCategoryLabel(category)}
                  <span>{providerGroups.get(category)?.length || 0}</span>
                </div>
                {(providerGroups.get(category) || []).map((provider) => (
                  <div
                    key={provider.provider}
                    className={`provider-row ${
                      activeProvider?.provider === provider.provider ? 'active' : ''
                    }`}
                  >
                    <button
                      type="button"
                      className="provider-row-main"
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
                        <div className="provider-meta-line">
                          <span className={`provider-status ${provider.api_key ? 'ready' : 'empty'}`}>
                            {provider.api_key ? '已配置' : '未配置'}
                          </span>
                          <span className="provider-type-chip">
                            {getProviderCategoryLabel(getProviderCategory(provider.provider))}
                          </span>
                        </div>
                      </div>
                    </button>
                    <label className={`provider-switch ${provider.is_active ? 'on' : 'off'}`}>
                      <input
                        type="checkbox"
                        checked={provider.is_active}
                        disabled={togglingProvider === provider.provider}
                        onChange={(event) =>
                          handleToggleProvider(provider.provider, event.target.checked)
                        }
                      />
                      <span className="provider-switch-track">
                        <span className="provider-switch-thumb" />
                      </span>
                    </label>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        <div className="provider-footer-actions">
          <button
            type="button"
            className="provider-footer-btn"
            onClick={() => {
              setShowCreateProviderForm((prev) => !prev)
              if (showCreateProviderForm) setNewProviderId('')
            }}
            title="新增自定义服务"
          >
            +
          </button>
          <button
            type="button"
            className="provider-footer-btn"
            onClick={handleDeleteCurrentProvider}
            title="删除当前选中服务"
            disabled={!activeProvider || deletingProvider === activeProvider.provider}
          >
            -
          </button>
        </div>
        {showCreateProviderForm ? (
          <div className="provider-create-box">
            <input
              type="text"
              placeholder="自定义服务 ID (如 my-translate-service)"
              value={newProviderId}
              onChange={(event) => setNewProviderId(event.target.value)}
            />
            <div className="provider-create-actions">
              <button type="button" className="btn btn-secondary" onClick={handleQuickAddProvider}>
                创建
              </button>
              <button
                type="button"
                className="btn btn-link"
                onClick={() => {
                  setShowCreateProviderForm(false)
                  setNewProviderId('')
                }}
              >
                取消
              </button>
            </div>
          </div>
        ) : null}
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
              <div className="provider-category-tag">
                {getProviderCategoryLabel(getProviderCategory(activeProvider.provider))}
              </div>
              <div className={`provider-live-state ${activeProvider.is_active ? 'on' : 'off'}`}>
                {activeProvider.is_active ? '启用中' : '已停用'}
              </div>
              <div className="provider-updated">
                更新于 {new Date(activeProvider.updated_at).toLocaleString()}
              </div>
            </div>

            <div className="helper-block">
              <div className="helper-title">{formProfile.title}</div>
              <div className="helper-text">{formProfile.description}</div>
            </div>

            <div className="form-group">
              <label htmlFor="provider-name">服务名称</label>
              <input id="provider-name" type="text" value={activeProvider.label} readOnly />
            </div>

            <div className="form-group">
              <label htmlFor="provider-key">{formProfile.apiKeyLabel}</label>
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

            {formProfile.showBaseUrl ? (
              <div className="form-group">
                <label htmlFor="provider-base">{formProfile.baseUrlLabel}</label>
                <input
                  id="provider-base"
                  type="text"
                  placeholder={getBasePlaceholder(activeProvider.provider, activeCategory)}
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              </div>
            ) : null}

            {formProfile.showModels ? (
              <div className="form-group">
                <label>{formProfile.modelLabel}</label>
                <div className="model-input-row">
                  <input
                    type="text"
                    placeholder={formProfile.modelPlaceholder}
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
            ) : null}

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
              <div className="section-header">
                <label>高级选项</label>
                <button
                  type="button"
                  className="btn btn-link"
                  onClick={() => setShowAdvanced((prev) => !prev)}
                >
                  {showAdvanced ? '收起' : '展开'}
                </button>
              </div>
              {!showAdvanced ? (
                <div className="helper-text">
                  {visibleAdvancedCards.length === 0
                    ? '暂无高级配置。'
                    : visibleAdvancedCards.map((item) => `${item.title} ${item.count}`).join(' · ')}
                </div>
              ) : (
                <div className="advanced-grid">
                  {visibleAdvancedCards.some((item) => item.id === 'endpoints') ? (
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
                  ) : null}

                  {visibleAdvancedCards.some((item) => item.id === 'env') ? (
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
                  ) : null}

                  {visibleAdvancedCards.some((item) => item.id === 'bindings') ? (
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
                  ) : null}
                </div>
              )}
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

const getBasePlaceholder = (provider: string, category: ProviderCategory | null) => {
  if (provider === 'openai') {
    return 'https://api.openai.com/v1'
  }
  if (provider === 'azure-openai') {
    return 'https://{resource}.openai.azure.com'
  }
  if (category === 'translation') {
    return '可选：自定义翻译网关地址'
  }
  if (category === 'search') {
    return '可选：搜索 API 地址'
  }
  if (category === 'ocr') {
    return '可选：OCR API 地址'
  }
  return 'https://'
}

function getFormProfile(category: ProviderCategory | null) {
  if (category === 'translation') {
    return {
      title: '翻译服务',
      description: '默认展示精简配置。仅需 API Key，其他参数可在高级选项中查看。',
      apiKeyLabel: 'API Key',
      showBaseUrl: true,
      baseUrlLabel: '接口地址（可选）',
      showModels: false,
      modelLabel: '',
      modelPlaceholder: '',
    }
  }
  if (category === 'search') {
    return {
      title: '搜索服务',
      description: '优先配置 Key 与接口地址，模型参数通常不需要配置。',
      apiKeyLabel: 'API Key',
      showBaseUrl: true,
      baseUrlLabel: '接口地址',
      showModels: false,
      modelLabel: '',
      modelPlaceholder: '',
    }
  }
  if (category === 'ocr') {
    return {
      title: 'OCR 服务',
      description: '识别服务使用简化配置，减少无关模型项干扰。',
      apiKeyLabel: 'API Key',
      showBaseUrl: true,
      baseUrlLabel: '接口地址',
      showModels: false,
      modelLabel: '',
      modelPlaceholder: '',
    }
  }
  if (category === 'other') {
    return {
      title: '通用服务',
      description: '可按服务文档填写 Key 与基础地址。',
      apiKeyLabel: 'API Key / Token',
      showBaseUrl: true,
      baseUrlLabel: '接口地址',
      showModels: false,
      modelLabel: '',
      modelPlaceholder: '',
    }
  }
  return {
    title: '模型服务',
    description: '支持模型列表、路径关联与应用绑定，适合多客户端切换场景。',
    apiKeyLabel: 'API Key',
    showBaseUrl: true,
    baseUrlLabel: 'API Base URL',
    showModels: true,
    modelLabel: '模型列表',
    modelPlaceholder: '输入模型名称，例如 gpt-4o-mini',
  }
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
