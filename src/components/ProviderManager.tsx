import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './ProviderManager.css'
import {
  DEFAULT_PROVIDER_DETAILS,
  ProviderAppBindingInput,
  ProviderConfig,
  ProviderDetails,
  ProviderEndpointInput,
  ProviderEnvVarInput,
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
    label: string,
    apiKey: string,
    baseUrl: string,
    models: string[],
    details?: ProviderDetails,
    endpoints?: ProviderEndpointInput[],
    envVars?: ProviderEnvVarInput[],
    appBindings?: ProviderAppBindingInput[]
  ) => Promise<void> | void
  onToggleProviderActive: (provider: string, isActive: boolean) => Promise<void> | void
  onDeleteProvider: (provider: string) => Promise<void> | void
  credentials: { id: string; provider: string; source?: string | null }[]
  projects: Project[]
  projectLabelsByCredential: Record<string, string>
  loading?: boolean
}

const CATEGORY_ORDER: ProviderCategory[] = ['model', 'translation', 'search', 'ocr', 'other']
const createLocalId = () =>
  `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

type EditableEndpoint = Required<ProviderEndpointInput>
type EditableEnvVar = Required<ProviderEnvVarInput>
type EditableBinding = Required<ProviderAppBindingInput>
type EndpointSpeedTestResult = {
  requested_url: string
  tested_url?: string | null
  success: boolean
  status_code?: number | null
  latency_ms?: number | null
  error?: string | null
}

const sanitizeDetails = (details: ProviderDetails): ProviderDetails => {
  const normalized: ProviderDetails = {
    ...DEFAULT_PROVIDER_DETAILS,
    ...details,
  }
  normalized.website_url = normalized.website_url.trim()
  normalized.notes = normalized.notes.trim()
  normalized.main_model = normalized.main_model.trim()
  normalized.reasoning_model = normalized.reasoning_model.trim()
  normalized.default_haiku_model = normalized.default_haiku_model.trim()
  normalized.default_sonnet_model = normalized.default_sonnet_model.trim()
  normalized.default_opus_model = normalized.default_opus_model.trim()
  normalized.settings_json =
    normalized.settings_json.trim() || DEFAULT_PROVIDER_DETAILS.settings_json
  normalized.test_model = normalized.test_model.trim()
  normalized.test_prompt = normalized.test_prompt.trim()
  normalized.proxy_url = normalized.proxy_url.trim()
  normalized.proxy_username = normalized.proxy_username.trim()
  normalized.proxy_password = normalized.proxy_password.trim()
  if (normalized.test_timeout_secs !== null && normalized.test_timeout_secs !== undefined) {
    normalized.test_timeout_secs =
      normalized.test_timeout_secs > 0 ? normalized.test_timeout_secs : null
  }
  if (
    normalized.test_degraded_threshold_ms !== null &&
    normalized.test_degraded_threshold_ms !== undefined
  ) {
    normalized.test_degraded_threshold_ms =
      normalized.test_degraded_threshold_ms > 0 ? normalized.test_degraded_threshold_ms : null
  }
  if (normalized.test_max_retries !== null && normalized.test_max_retries !== undefined) {
    normalized.test_max_retries = normalized.test_max_retries >= 0 ? normalized.test_max_retries : null
  }
  return normalized
}

const resolveDetails = (provider: ProviderConfig): ProviderDetails => {
  return sanitizeDetails({
    ...DEFAULT_PROVIDER_DETAILS,
    ...(provider.details || {}),
  })
}

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
  const [providerLabel, setProviderLabel] = useState('')
  const [details, setDetails] = useState<ProviderDetails>(DEFAULT_PROVIDER_DETAILS)
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [togglingProvider, setTogglingProvider] = useState<string | null>(null)
  const [deletingProvider, setDeletingProvider] = useState<string | null>(null)
  const [showCreateProviderForm, setShowCreateProviderForm] = useState(false)
  const [newProviderId, setNewProviderId] = useState('')
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [categoryFilter, setCategoryFilter] = useState<ProviderCategory | 'all'>('all')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [editableEndpoints, setEditableEndpoints] = useState<EditableEndpoint[]>([])
  const [editableEnvVars, setEditableEnvVars] = useState<EditableEnvVar[]>([])
  const [editableAppBindings, setEditableAppBindings] = useState<EditableBinding[]>([])
  const [testingEndpointId, setTestingEndpointId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, EndpointSpeedTestResult>>({})
  const [testingBaseUrl, setTestingBaseUrl] = useState(false)
  const [baseUrlTestResult, setBaseUrlTestResult] = useState<EndpointSpeedTestResult | null>(null)

  const activeProvider = selectedProvider
  const activeCategory = activeProvider ? getProviderCategory(activeProvider.provider) : null
  const endpoints = editableEndpoints
  const envVars = editableEnvVars
  const appBindings = editableAppBindings
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
      const resolvedDetails = resolveDetails(activeProvider)
      setProviderLabel(activeProvider.label || activeProvider.provider)
      setApiKey(activeProvider.api_key || '')
      setBaseUrl(activeProvider.base_url || '')
      setModels(activeProvider.models || [])
      setDetails(resolvedDetails)
      setNewModel('')
      setShowKey(false)
      setStatus('idle')
      setShowAdvanced(getProviderCategory(activeProvider.provider) === 'model')
      setTestingEndpointId(null)
      setTestingBaseUrl(false)
      setTestResults({})
      setBaseUrlTestResult(null)
      setEditableEndpoints(
        (activeProvider.endpoints || []).map((item) => ({
          id: item.id || createLocalId(),
          base_url: item.base_url || '',
          headers: item.headers || null,
          timeout_ms: item.timeout_ms ?? null,
          proxy_url: item.proxy_url || null,
          is_primary: !!item.is_primary,
        }))
      )
      setEditableEnvVars(
        (activeProvider.env_vars || []).map((item) => ({
          id: item.id || createLocalId(),
          key: item.key || '',
          value: item.value || '',
          is_secret: item.is_secret,
        }))
      )
      setEditableAppBindings(
        (activeProvider.app_bindings || []).map((item) => ({
          id: item.id || createLocalId(),
          app_type: item.app_type || '',
          config_path: item.config_path || '',
          enabled: item.enabled,
        }))
      )
    } else {
      setProviderLabel('')
      setDetails(DEFAULT_PROVIDER_DETAILS)
      setEditableEndpoints([])
      setEditableEnvVars([])
      setEditableAppBindings([])
      setTestResults({})
      setBaseUrlTestResult(null)
    }
  }, [activeProvider])

  const dirty = useMemo(() => {
    if (!activeProvider) return false
    const currentDetails = resolveDetails(activeProvider)
    return (
      providerLabel.trim() !== (activeProvider.label || activeProvider.provider) ||
      apiKey !== (activeProvider.api_key || '') ||
      baseUrl !== (activeProvider.base_url || '') ||
      models.join('|') !== (activeProvider.models || []).join('|') ||
      serializeDetails(details) !== serializeDetails(currentDetails) ||
      serializeEndpoints(editableEndpoints) !== serializeEndpoints(activeProvider.endpoints || []) ||
      serializeEnvVars(editableEnvVars) !== serializeEnvVars(activeProvider.env_vars || []) ||
      serializeBindings(editableAppBindings) !== serializeBindings(activeProvider.app_bindings || [])
    )
  }, [
    activeProvider,
    providerLabel,
    apiKey,
    baseUrl,
    models,
    details,
    editableEndpoints,
    editableEnvVars,
    editableAppBindings,
  ])

  useEffect(() => {
    if (status !== 'idle') {
      setStatus('idle')
    }
  }, [providerLabel, apiKey, baseUrl, models, details, editableEndpoints, editableEnvVars, editableAppBindings])

  const handleSave = async () => {
    if (!activeProvider || !dirty) return
    const normalizedDetails = sanitizeDetails(details)
    try {
      JSON.parse(normalizedDetails.settings_json)
    } catch {
      alert('配置 JSON 格式错误，请修复后再保存。')
      return
    }

    setSaving(true)
    setStatus('idle')
    try {
      await onSaveProvider(
        activeProvider.provider,
        providerLabel.trim() || activeProvider.provider,
        apiKey.trim(),
        baseUrl.trim().replace(/\/+$/, ''),
        models,
        normalizedDetails,
        sanitizeEndpoints(editableEndpoints),
        sanitizeEnvVars(editableEnvVars),
        sanitizeBindings(editableAppBindings)
      )
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

    await onSaveProvider(normalized, normalized, '', '', [], DEFAULT_PROVIDER_DETAILS)
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

  const runEndpointTest = async (targetUrl: string, endpointId?: string, headers?: string | null) => {
    const normalizedUrl = targetUrl.trim().replace(/\/+$/, '')
    if (!normalizedUrl) {
      alert('请先填写请求地址')
      return
    }
    if (endpointId) {
      setTestingEndpointId(endpointId)
    } else {
      setTestingBaseUrl(true)
    }
    try {
      const result = await invoke<EndpointSpeedTestResult>('test_provider_endpoint', {
        url: normalizedUrl,
        apiKey: apiKey.trim() || null,
        headers: headers || null,
        timeoutMs: 8000,
      })
      if (endpointId) {
        setTestResults((prev) => ({
          ...prev,
          [endpointId]: result,
        }))
      } else {
        setBaseUrlTestResult(result)
      }
    } catch (error) {
      const fallback: EndpointSpeedTestResult = {
        requested_url: normalizedUrl,
        tested_url: null,
        success: false,
        status_code: null,
        latency_ms: null,
        error: String(error),
      }
      if (endpointId) {
        setTestResults((prev) => ({
          ...prev,
          [endpointId]: fallback,
        }))
      } else {
        setBaseUrlTestResult(fallback)
      }
    } finally {
      if (endpointId) {
        setTestingEndpointId(null)
      } else {
        setTestingBaseUrl(false)
      }
    }
  }

  const handleFormatSettingsJson = () => {
    try {
      const parsed = JSON.parse(details.settings_json || '{}')
      setDetails((prev) => ({
        ...prev,
        settings_json: JSON.stringify(parsed, null, 2),
      }))
    } catch {
      alert('配置 JSON 格式错误，无法格式化。')
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

            <div className="provider-grid">
              <div className="form-group">
                <label htmlFor="provider-name">供应商名称</label>
                <input
                  id="provider-name"
                  type="text"
                  placeholder="例如：Claude 官方"
                  value={providerLabel}
                  onChange={(event) => setProviderLabel(event.target.value)}
                />
              </div>
              <div className="form-group">
                <label htmlFor="provider-notes">备注</label>
                <input
                  id="provider-notes"
                  type="text"
                  placeholder="例如：公司专用账号"
                  value={details.notes}
                  onChange={(event) =>
                    setDetails((prev) => ({
                      ...prev,
                      notes: event.target.value,
                    }))
                  }
                />
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="provider-website">官网链接</label>
              <input
                id="provider-website"
                type="text"
                placeholder="https://example.com（可选）"
                value={details.website_url}
                onChange={(event) =>
                  setDetails((prev) => ({
                    ...prev,
                    website_url: event.target.value,
                  }))
                }
              />
            </div>

            <div className="form-group">
              <label htmlFor="provider-key">{formProfile.apiKeyLabel}</label>
              <div className="input-row">
                <input
                  id="provider-key"
                  type={showKey ? 'text' : 'password'}
                  placeholder="只需要填这里，下方配置会自动填充"
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
                <div className="section-header">
                  <label htmlFor="provider-base">{formProfile.baseUrlLabel || '请求地址'}</label>
                  <button
                    type="button"
                    className="btn btn-link provider-mini-link"
                    onClick={() => {
                      setShowAdvanced(true)
                      void runEndpointTest(baseUrl)
                    }}
                  >
                    管理与测速
                  </button>
                </div>
                <input
                  id="provider-base"
                  type="text"
                  placeholder={getBasePlaceholder(activeProvider.provider, activeCategory)}
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
                {baseUrlTestResult ? (
                  <div
                    className={`endpoint-test-result ${
                      baseUrlTestResult.success ? 'success' : 'error'
                    }`}
                  >
                    {baseUrlTestResult.success
                      ? `测速成功：${baseUrlTestResult.latency_ms}ms（HTTP ${baseUrlTestResult.status_code ?? 200}）`
                      : `测速失败：${baseUrlTestResult.error || '未知错误'}`}
                  </div>
                ) : null}
                <div className="provider-tip">
                  <span>💡</span>
                  <span>{formProfile.baseUrlTip}</span>
                  <button
                    type="button"
                    className="btn btn-link provider-mini-link"
                    disabled={testingBaseUrl}
                    onClick={() => void runEndpointTest(baseUrl)}
                  >
                    {testingBaseUrl ? '测速中...' : '立即测速'}
                  </button>
                </div>
              </div>
            ) : null}

            {formProfile.showModels ? (
              <>
                <div className="provider-grid">
                  <div className="form-group">
                    <label htmlFor="main-model">主模型</label>
                    <input
                      id="main-model"
                      type="text"
                      value={details.main_model}
                      onChange={(event) =>
                        setDetails((prev) => ({
                          ...prev,
                          main_model: event.target.value,
                        }))
                      }
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="reasoning-model">推理模型 (Thinking)</label>
                    <input
                      id="reasoning-model"
                      type="text"
                      value={details.reasoning_model}
                      onChange={(event) =>
                        setDetails((prev) => ({
                          ...prev,
                          reasoning_model: event.target.value,
                        }))
                      }
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="haiku-model">Haiku 默认模型</label>
                    <input
                      id="haiku-model"
                      type="text"
                      value={details.default_haiku_model}
                      onChange={(event) =>
                        setDetails((prev) => ({
                          ...prev,
                          default_haiku_model: event.target.value,
                        }))
                      }
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="sonnet-model">Sonnet 默认模型</label>
                    <input
                      id="sonnet-model"
                      type="text"
                      value={details.default_sonnet_model}
                      onChange={(event) =>
                        setDetails((prev) => ({
                          ...prev,
                          default_sonnet_model: event.target.value,
                        }))
                      }
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="opus-model">Opus 默认模型</label>
                    <input
                      id="opus-model"
                      type="text"
                      value={details.default_opus_model}
                      onChange={(event) =>
                        setDetails((prev) => ({
                          ...prev,
                          default_opus_model: event.target.value,
                        }))
                      }
                    />
                  </div>
                </div>

                <div className="helper-text">可选：指定默认使用的 Claude 模型，留空则使用系统默认。</div>
              </>
            ) : null}

            <div className="form-group">
              <div className="section-header">
                <label htmlFor="settings-json">配置 JSON</label>
                <div className="provider-json-actions">
                  <label className="inline-toggle">
                    <input
                      type="checkbox"
                      checked={details.use_common_config}
                      onChange={(event) =>
                        setDetails((prev) => ({
                          ...prev,
                          use_common_config: event.target.checked,
                        }))
                      }
                    />
                    写入通用配置
                  </label>
                  <button type="button" className="btn btn-link provider-mini-link" onClick={handleFormatSettingsJson}>
                    格式化
                  </button>
                </div>
              </div>
              <textarea
                id="settings-json"
                rows={8}
                value={details.settings_json}
                onChange={(event) =>
                  setDetails((prev) => ({
                    ...prev,
                    settings_json: event.target.value,
                  }))
                }
              />
            </div>

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
                  <div className="advanced-card">
                    <div className="advanced-title advanced-title-row">
                      <span>模型测试配置</span>
                      <label className="inline-toggle">
                        <input
                          type="checkbox"
                          checked={details.test_config_enabled}
                          onChange={(event) =>
                            setDetails((prev) => ({
                              ...prev,
                              test_config_enabled: event.target.checked,
                            }))
                          }
                        />
                        使用单独配置
                      </label>
                    </div>
                    <div className="advanced-list">
                      <input
                        type="text"
                        className="compact-input"
                        placeholder="测试模型（可选）"
                        disabled={!details.test_config_enabled}
                        value={details.test_model}
                        onChange={(event) =>
                          setDetails((prev) => ({
                            ...prev,
                            test_model: event.target.value,
                          }))
                        }
                      />
                      <div className="inline-fields">
                        <input
                          type="number"
                          min={1}
                          className="compact-input compact-input-sm"
                          placeholder="超时(秒)"
                          disabled={!details.test_config_enabled}
                          value={details.test_timeout_secs ?? ''}
                          onChange={(event) =>
                            setDetails((prev) => ({
                              ...prev,
                              test_timeout_secs: event.target.value
                                ? Number(event.target.value)
                                : null,
                            }))
                          }
                        />
                        <input
                          type="number"
                          min={100}
                          className="compact-input compact-input-sm"
                          placeholder="降级阈值(ms)"
                          disabled={!details.test_config_enabled}
                          value={details.test_degraded_threshold_ms ?? ''}
                          onChange={(event) =>
                            setDetails((prev) => ({
                              ...prev,
                              test_degraded_threshold_ms: event.target.value
                                ? Number(event.target.value)
                                : null,
                            }))
                          }
                        />
                        <input
                          type="number"
                          min={0}
                          className="compact-input compact-input-sm"
                          placeholder="最大重试"
                          disabled={!details.test_config_enabled}
                          value={details.test_max_retries ?? ''}
                          onChange={(event) =>
                            setDetails((prev) => ({
                              ...prev,
                              test_max_retries: event.target.value
                                ? Number(event.target.value)
                                : null,
                            }))
                          }
                        />
                      </div>
                      <input
                        type="text"
                        className="compact-input"
                        placeholder="测试提示词（可选）"
                        disabled={!details.test_config_enabled}
                        value={details.test_prompt}
                        onChange={(event) =>
                          setDetails((prev) => ({
                            ...prev,
                            test_prompt: event.target.value,
                          }))
                        }
                      />
                    </div>
                  </div>

                  <div className="advanced-card">
                    <div className="advanced-title advanced-title-row">
                      <span>代理配置</span>
                      <label className="inline-toggle">
                        <input
                          type="checkbox"
                          checked={details.proxy_config_enabled}
                          onChange={(event) =>
                            setDetails((prev) => ({
                              ...prev,
                              proxy_config_enabled: event.target.checked,
                            }))
                          }
                        />
                        使用单独代理
                      </label>
                    </div>
                    <div className="advanced-list">
                      <input
                        type="text"
                        className="compact-input"
                        placeholder="http://127.0.0.1:7890 / socks5://127.0.0.1:1080"
                        disabled={!details.proxy_config_enabled}
                        value={details.proxy_url}
                        onChange={(event) =>
                          setDetails((prev) => ({
                            ...prev,
                            proxy_url: event.target.value,
                          }))
                        }
                      />
                      <div className="inline-fields">
                        <input
                          type="text"
                          className="compact-input"
                          placeholder="用户名（可选）"
                          disabled={!details.proxy_config_enabled}
                          value={details.proxy_username}
                          onChange={(event) =>
                            setDetails((prev) => ({
                              ...prev,
                              proxy_username: event.target.value,
                            }))
                          }
                        />
                        <input
                          type="password"
                          className="compact-input"
                          placeholder="密码（可选）"
                          disabled={!details.proxy_config_enabled}
                          value={details.proxy_password}
                          onChange={(event) =>
                            setDetails((prev) => ({
                              ...prev,
                              proxy_password: event.target.value,
                            }))
                          }
                        />
                      </div>
                    </div>
                  </div>

                  {visibleAdvancedCards.some((item) => item.id === 'endpoints') ? (
                    <div className="advanced-card">
                      <div className="advanced-title advanced-title-row">
                        <span>端点</span>
                        <button
                          type="button"
                          className="btn btn-link"
                          onClick={() =>
                            setEditableEndpoints((prev) => [
                              ...prev,
                              {
                                id: createLocalId(),
                                base_url: '',
                                headers: null,
                                timeout_ms: null,
                                proxy_url: null,
                                is_primary: prev.length === 0,
                              },
                            ])
                          }
                        >
                          + 添加
                        </button>
                      </div>
                      {endpoints.length === 0 ? (
                        <div className="helper-text">暂无端点配置。</div>
                      ) : (
                        <div className="advanced-list">
                          {endpoints.map((endpoint, index) => (
                            <div key={endpoint.id} className="endpoint-item">
                              <div className="inline-fields">
                                <input
                                  type="text"
                                  className="compact-input"
                                  placeholder="https://api.example.com/v1"
                                  value={endpoint.base_url}
                                  onChange={(event) =>
                                    setEditableEndpoints((prev) =>
                                      prev.map((item) =>
                                        item.id === endpoint.id
                                          ? { ...item, base_url: event.target.value }
                                          : item
                                      )
                                    )
                                  }
                                />
                              </div>
                              <div className="inline-fields">
                                <input
                                  type="text"
                                  className="compact-input"
                                  placeholder="Headers (可选)"
                                  value={endpoint.headers || ''}
                                  onChange={(event) =>
                                    setEditableEndpoints((prev) =>
                                      prev.map((item) =>
                                        item.id === endpoint.id
                                          ? { ...item, headers: event.target.value || null }
                                          : item
                                      )
                                    )
                                  }
                                />
                                <input
                                  type="number"
                                  min={0}
                                  className="compact-input compact-input-sm"
                                  placeholder="超时(ms)"
                                  value={endpoint.timeout_ms ?? ''}
                                  onChange={(event) =>
                                    setEditableEndpoints((prev) =>
                                      prev.map((item) =>
                                        item.id === endpoint.id
                                          ? {
                                              ...item,
                                              timeout_ms: event.target.value
                                                ? Number(event.target.value)
                                                : null,
                                            }
                                          : item
                                      )
                                    )
                                  }
                                />
                              </div>
                              <div className="inline-fields">
                                <input
                                  type="text"
                                  className="compact-input"
                                  placeholder="代理 URL (可选)"
                                  value={endpoint.proxy_url || ''}
                                  onChange={(event) =>
                                    setEditableEndpoints((prev) =>
                                      prev.map((item) =>
                                        item.id === endpoint.id
                                          ? { ...item, proxy_url: event.target.value || null }
                                          : item
                                      )
                                    )
                                  }
                                />
                              </div>
                              <div className="item-actions">
                                <label className="inline-toggle">
                                  <input
                                    type="checkbox"
                                    checked={endpoint.is_primary}
                                    onChange={(event) =>
                                      setEditableEndpoints((prev) =>
                                        prev.map((item, itemIndex) => ({
                                          ...item,
                                          is_primary: event.target.checked
                                            ? item.id === endpoint.id
                                            : itemIndex === 0,
                                        }))
                                      )
                                    }
                                  />
                                  主端点
                                </label>
                                <button
                                  type="button"
                                  className="btn btn-link"
                                  disabled={testingEndpointId === endpoint.id}
                                  onClick={() =>
                                    void runEndpointTest(
                                      endpoint.base_url,
                                      endpoint.id,
                                      endpoint.headers || null
                                    )
                                  }
                                >
                                  {testingEndpointId === endpoint.id ? '测速中...' : '测速'}
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-link danger-link"
                                  onClick={() =>
                                    setEditableEndpoints((prev) => {
                                      const next = prev.filter((item) => item.id !== endpoint.id)
                                      if (next.length > 0 && !next.some((item) => item.is_primary)) {
                                        next[0] = { ...next[0], is_primary: true }
                                      }
                                      return next
                                    })
                                  }
                                >
                                  删除
                                </button>
                                <span className="item-index">#{index + 1}</span>
                              </div>
                              {testResults[endpoint.id] ? (
                                <div
                                  className={`endpoint-test-result ${
                                    testResults[endpoint.id].success ? 'success' : 'error'
                                  }`}
                                >
                                  {testResults[endpoint.id].success
                                    ? `延迟 ${testResults[endpoint.id].latency_ms}ms（HTTP ${
                                        testResults[endpoint.id].status_code ?? 200
                                      }）`
                                    : `测速失败：${testResults[endpoint.id].error || '未知错误'}`}
                                </div>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}

                  {visibleAdvancedCards.some((item) => item.id === 'env') ? (
                    <div className="advanced-card">
                      <div className="advanced-title advanced-title-row">
                        <span>环境变量</span>
                        <button
                          type="button"
                          className="btn btn-link"
                          onClick={() =>
                            setEditableEnvVars((prev) => [
                              ...prev,
                              {
                                id: createLocalId(),
                                key: '',
                                value: '',
                                is_secret: true,
                              },
                            ])
                          }
                        >
                          + 添加
                        </button>
                      </div>
                      {envVars.length === 0 ? (
                        <div className="helper-text">暂无环境变量。</div>
                      ) : (
                        <div className="advanced-list">
                          {envVars.map((envVar) => (
                            <div key={envVar.id} className="env-item">
                              <div className="inline-fields">
                                <input
                                  type="text"
                                  className="compact-input"
                                  placeholder="变量名，如 OPENAI_API_KEY"
                                  value={envVar.key}
                                  onChange={(event) =>
                                    setEditableEnvVars((prev) =>
                                      prev.map((item) =>
                                        item.id === envVar.id
                                          ? { ...item, key: event.target.value }
                                          : item
                                      )
                                    )
                                  }
                                />
                                <input
                                  type={envVar.is_secret ? 'password' : 'text'}
                                  className="compact-input"
                                  placeholder="变量值"
                                  value={envVar.value}
                                  onChange={(event) =>
                                    setEditableEnvVars((prev) =>
                                      prev.map((item) =>
                                        item.id === envVar.id
                                          ? { ...item, value: event.target.value }
                                          : item
                                      )
                                    )
                                  }
                                />
                              </div>
                              <div className="item-actions">
                                <label className="inline-toggle">
                                  <input
                                    type="checkbox"
                                    checked={envVar.is_secret}
                                    onChange={(event) =>
                                      setEditableEnvVars((prev) =>
                                        prev.map((item) =>
                                          item.id === envVar.id
                                            ? { ...item, is_secret: event.target.checked }
                                            : item
                                        )
                                      )
                                    }
                                  />
                                  密钥字段
                                </label>
                                <button
                                  type="button"
                                  className="btn btn-link danger-link"
                                  onClick={() =>
                                    setEditableEnvVars((prev) =>
                                      prev.filter((item) => item.id !== envVar.id)
                                    )
                                  }
                                >
                                  删除
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}

                  {visibleAdvancedCards.some((item) => item.id === 'bindings') ? (
                    <div className="advanced-card">
                      <div className="advanced-title advanced-title-row">
                        <span>应用绑定</span>
                        <button
                          type="button"
                          className="btn btn-link"
                          onClick={() =>
                            setEditableAppBindings((prev) => [
                              ...prev,
                              {
                                id: createLocalId(),
                                app_type: '',
                                config_path: '',
                                enabled: true,
                              },
                            ])
                          }
                        >
                          + 添加
                        </button>
                      </div>
                      {appBindings.length === 0 ? (
                        <div className="helper-text">暂无应用绑定。</div>
                      ) : (
                        <div className="advanced-list">
                          {appBindings.map((binding) => (
                            <div key={binding.id} className="binding-item">
                              <div className="inline-fields">
                                <input
                                  type="text"
                                  className="compact-input compact-input-sm"
                                  placeholder="app_type，如 codex"
                                  value={binding.app_type}
                                  onChange={(event) =>
                                    setEditableAppBindings((prev) =>
                                      prev.map((item) =>
                                        item.id === binding.id
                                          ? { ...item, app_type: event.target.value }
                                          : item
                                      )
                                    )
                                  }
                                />
                                <input
                                  type="text"
                                  className="compact-input"
                                  placeholder="配置路径，可留空"
                                  value={binding.config_path}
                                  onChange={(event) =>
                                    setEditableAppBindings((prev) =>
                                      prev.map((item) =>
                                        item.id === binding.id
                                          ? { ...item, config_path: event.target.value }
                                          : item
                                      )
                                    )
                                  }
                                />
                              </div>
                              <div className="item-actions">
                                <label className="inline-toggle">
                                  <input
                                    type="checkbox"
                                    checked={binding.enabled}
                                    onChange={(event) =>
                                      setEditableAppBindings((prev) =>
                                        prev.map((item) =>
                                          item.id === binding.id
                                            ? { ...item, enabled: event.target.checked }
                                            : item
                                        )
                                      )
                                    }
                                  />
                                  启用
                                </label>
                                <button
                                  type="button"
                                  className="btn btn-link danger-link"
                                  onClick={() =>
                                    setEditableAppBindings((prev) =>
                                      prev.filter((item) => item.id !== binding.id)
                                    )
                                  }
                                >
                                  删除
                                </button>
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
      baseUrlTip: '可选：填写翻译服务的端点地址，不要以斜杠结尾。测速默认验证连通性（不校验翻译结果）。',
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
      baseUrlTip: '填写搜索服务 API 端点地址，不要以斜杠结尾。',
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
      baseUrlTip: '填写 OCR 服务 API 端点地址，不要以斜杠结尾。',
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
      baseUrlTip: '按供应商文档填写服务端点地址，不要以斜杠结尾。',
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
    baseUrlTip: '填写兼容 Claude API 的服务端点地址，不要以斜杠结尾。',
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

const sanitizeEndpoints = (items: Array<ProviderEndpointInput>) => {
  const normalized = items
    .map((item) => ({
      id: item.id,
      base_url: item.base_url.trim(),
      headers: item.headers?.trim() || null,
      timeout_ms: item.timeout_ms && item.timeout_ms > 0 ? item.timeout_ms : null,
      proxy_url: item.proxy_url?.trim() || null,
      is_primary: item.is_primary,
    }))
    .filter((item) => item.base_url.length > 0)

  if (normalized.length > 0 && !normalized.some((item) => item.is_primary)) {
    normalized[0].is_primary = true
  }
  return normalized
}

const sanitizeEnvVars = (items: Array<ProviderEnvVarInput>) => {
  return items
    .map((item) => ({
      id: item.id,
      key: item.key.trim(),
      value: item.value || '',
      is_secret: item.is_secret,
    }))
    .filter((item) => item.key.length > 0)
}

const sanitizeBindings = (items: Array<ProviderAppBindingInput>) => {
  const seen = new Set<string>()
  return items
    .map((item) => ({
      id: item.id,
      app_type: item.app_type.trim(),
      config_path: item.config_path.trim(),
      enabled: item.enabled,
    }))
    .filter((item) => {
      if (!item.app_type) return false
      const key = item.app_type.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

const serializeEndpoints = (items: Array<ProviderEndpointInput>) => {
  return JSON.stringify(sanitizeEndpoints(items))
}

const serializeEnvVars = (items: Array<ProviderEnvVarInput>) => {
  return JSON.stringify(sanitizeEnvVars(items))
}

const serializeBindings = (items: Array<ProviderAppBindingInput>) => {
  return JSON.stringify(sanitizeBindings(items))
}

const serializeDetails = (details: ProviderDetails) => {
  return JSON.stringify(sanitizeDetails(details))
}
