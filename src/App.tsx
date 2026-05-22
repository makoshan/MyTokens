import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { assertNativePasskey, isNativePasskey } from './utils/passkeyNative'
import './App.css'
import KeyList from './components/KeyList'
import KeyForm from './components/KeyForm'
import ImportModal from './components/ImportModal'
import ProviderManager from './components/ProviderManager'
import ProjectManager from './components/ProjectManager'
import PromptManager, { PromptTemplate } from './components/PromptManager'
import UsageDashboard from './components/UsageDashboard'
import GlobalSettings from './components/GlobalSettings'
import ApplicationManager from './components/ApplicationManager'
import OpencodeMcpManager from './components/OpencodeMcpManager'
import OpencodeSkillManager from './components/OpencodeSkillManager'
import ClippyAssistant from './components/ClippyAssistant'
import VoiceInputController from './components/VoiceInputController'
import CryptoWalletManager, { CryptoWallet } from './components/CryptoWalletManager'
import ComputeGatewayManager from './components/ComputeGatewayManager'
import {
  APP_NAV_ITEMS,
  buildHomeQuickStats,
  type AppNavView,
} from './utils/homeNavigation'
import {
  shouldShowVaultPasskeyLogin,
  type VaultAuthMethod,
  type VaultUnlockState,
} from './utils/vaultUnlock'
import type { VoiceInputHistoryRecord } from './types/settings'
import {
  DEFAULT_PROVIDER_DETAILS,
  ProviderDetails,
  ProviderAppBindingInput,
  ProviderConfig,
  ProviderEndpointInput,
  ProviderEnvVarInput,
} from './types/provider'
import type { Project } from './types/project'
import { normalizeProjectLabel } from './utils/project'
import { getProviderCategory, getProviderCategoryLabel, getProviderDisplayName } from './utils/provider'
import { getQuotaStatus, type QuotaStatus } from './utils/usage'
import {
  UNMATCHED_PROJECT_NAME,
  buildProviderContextMap,
  resolveCredentialProjectName,
} from './utils/linkage'

interface Credential {
  id: string
  provider: string
  name: string
  key: string
  created_at: string
  is_active: boolean
  source?: string | null
}

interface PromptTemplateRecord extends PromptTemplate {}

interface ParsedKey {
  provider: string
  name: string
  key: string
  source?: string
  variable?: string
}

type View = AppNavView

const VIEW_META: Record<View, { title: string; description: string }> = {
  dashboard: {
    title: '监控总览',
    description: '实时查看用量、成本与预算风险。',
  },
  keys: {
    title: '密钥库',
    description: '集中管理所有 API Key 与配置。',
  },
  projects: {
    title: '项目',
    description: '按项目管理目录与默认密钥。',
  },
  providers: {
    title: '提供商设置',
    description: '统一维护模型与 API 的接入配置。',
  },
  crypto: {
    title: 'Crypto 钱包',
    description: '管理本地钱包、链上地址与 Token 跟踪。',
  },
  apps: {
    title: '应用配置',
    description: '按应用绑定提供商与模型，快速切换 AI Key 路由。',
  },
  mcp: {
    title: 'MCP 管理',
    description: '按 OpenCode 配置管理 MCP 条目，支持增删改与保存。',
  },
  skills: {
    title: 'Skills 管理',
    description: '按 OpenCode 配置管理 Skills 条目，支持增删改与保存。',
  },
  prompts: {
    title: '提示词库',
    description: '集中管理系统提示词与模板。',
  },
  history: {
    title: '历史记录',
    description: '查看语音输入的转写、复制与取消记录。',
  },
  compute: {
    title: '算力网关',
    description: '管理云端网关账户、渠道、红包与兑换记录。',
  },
  settings: {
    title: '全局设置',
    description: '统一管理服务、集成、诊断与备份。',
  },
}

type UsageQuota = {
  percent_remaining: number
}

type UsageSnapshot = {
  provider_id: string
  quotas: UsageQuota[]
}

type DashboardOverview = {
  keys: number
  cryptoWallets: number
  providers: number
  apps: number
}

type ProviderUsageStatus = {
  provider_id: string
  enabled: boolean
  snapshot?: UsageSnapshot | null
}

type PasskeyBridgeStart = {
  token: string
  url: string
}

const statusOrder: Record<QuotaStatus, number> = {
  healthy: 0,
  warning: 1,
  critical: 2,
  depleted: 3,
}

const NOTIFY_COOLDOWN_MS = 6 * 60 * 60 * 1000
const STATUS_STORAGE_KEY = 'mykey-usage-status'
const LEGACY_PROJECT_LABELS_STORAGE_KEY = 'mykey-project-labels'

function evaluateStatus(percentRemaining: number): QuotaStatus {
  return getQuotaStatus(percentRemaining)
}

function loadLegacyProjectLabelState(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LEGACY_PROJECT_LABELS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const normalized: Record<string, string> = {}
    Object.entries(parsed).forEach(([key, value]) => {
      if (typeof value !== 'string') return
      const label = normalizeProjectLabel(value)
      if (label) normalized[key] = label
    })
    return normalized
  } catch {
    return {}
  }
}

function resolveProjectLabel(
  credential: Credential,
  projectLabelsByCredential: Record<string, string>,
  projects: Project[]
) {
  return resolveCredentialProjectName(credential, projectLabelsByCredential, projects)
}

function providerLabel(providerId: string) {
  return getProviderDisplayName(providerId)
}

function collectProviderModelNames(provider: ProviderConfig | null): string[] {
  if (!provider) return []
  const candidates = [
    ...(provider.models || []),
    provider.details?.main_model || '',
    provider.details?.reasoning_model || '',
    provider.details?.default_haiku_model || '',
    provider.details?.default_sonnet_model || '',
    provider.details?.default_opus_model || '',
    provider.details?.test_model || '',
  ]
  const seen = new Set<string>()
  const models: string[] = []
  candidates.forEach((value) => {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    models.push(trimmed)
  })
  return models
}

function loadStatusState(): Record<string, { status: QuotaStatus; lastNotifiedAt: number }> {
  try {
    const raw = localStorage.getItem(STATUS_STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveStatusState(state: Record<string, { status: QuotaStatus; lastNotifiedAt: number }>) {
  try {
    localStorage.setItem(STATUS_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // ignore
  }
}

async function sendSystemNotification(title: string, body: string) {
  if (!('Notification' in window)) return
  if (Notification.permission === 'default') {
    try {
      await Notification.requestPermission()
    } catch {
      return
    }
  }
  if (Notification.permission === 'granted') {
    new Notification(title, { body })
  }
}

function App() {
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [cryptoWallets, setCryptoWallets] = useState<CryptoWallet[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [prompts, setPrompts] = useState<PromptTemplateRecord[]>([])
  const [voiceHistory, setVoiceHistory] = useState<VoiceInputHistoryRecord[]>([])
  const [selectedKey, setSelectedKey] = useState<Credential | null>(null)
  const [selectedProvider, setSelectedProvider] = useState<ProviderConfig | null>(null)
  const [selectedPrompt, setSelectedPrompt] = useState<PromptTemplateRecord | null>(null)
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null)
  const [copiedVoiceHistoryId, setCopiedVoiceHistoryId] = useState<string | null>(null)
  const [view, setView] = useState<View>('dashboard')
  const [showForm, setShowForm] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [masterPassword, setMasterPassword] = useState('')
  const [authMethod, setAuthMethod] = useState<VaultAuthMethod>('master-password')
  const [vaultUnlockState, setVaultUnlockState] = useState<VaultUnlockState | null>(null)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [loadingKeys, setLoadingKeys] = useState(false)
  const [loadingProviders, setLoadingProviders] = useState(false)
  const [loadingCryptoWallets, setLoadingCryptoWallets] = useState(false)
  const [loadingPrompts, setLoadingPrompts] = useState(false)
  const [loadingVoiceHistory, setLoadingVoiceHistory] = useState(false)
  const [voiceHistoryError, setVoiceHistoryError] = useState<string | null>(null)
  const [hasPassword, setHasPassword] = useState<boolean | null>(null)
  const [projectLabelsByCredential, setProjectLabelsByCredential] = useState<Record<string, string>>({})
  const [projectFocus, setProjectFocus] = useState<{ name: string; token: number } | null>(null)
  const [dashboardOverview, setDashboardOverview] = useState<DashboardOverview>({
    keys: 0,
    cryptoWallets: 0,
    providers: 0,
    apps: 0,
  })
  const hasMigratedLegacyProjectLabels = useRef(false)

  const loadProjectLabels = async (credentialIds?: string[]) => {
    if (!masterPassword) return
    try {
      const labels = await invoke<Record<string, string>>('get_credential_project_labels', {
        masterPassword,
      })
      if (!credentialIds) {
        setProjectLabelsByCredential(labels)
        return
      }
      const idSet = new Set(credentialIds)
      const filtered = Object.fromEntries(
        Object.entries(labels).filter(([credentialId]) => idSet.has(credentialId))
      )
      setProjectLabelsByCredential(filtered)
    } catch (error) {
      console.error('Failed to load project labels:', error)
      setProjectLabelsByCredential({})
    }
  }

  const migrateLegacyProjectLabels = async (credentialIds: string[]) => {
    const legacy = loadLegacyProjectLabelState()
    const entries = Object.entries(legacy)
    if (!entries.length) return

    const idSet = new Set(credentialIds)
    try {
      for (const [credentialId, label] of entries) {
        if (!idSet.has(credentialId)) continue
        const normalized = normalizeProjectLabel(label)
        if (!normalized) continue
        await invoke('set_credential_project_label', {
          credentialId,
          label: normalized,
          masterPassword,
        })
      }
    } catch (error) {
      console.error('Failed to migrate legacy project labels:', error)
      return
    }

    localStorage.removeItem(LEGACY_PROJECT_LABELS_STORAGE_KEY)
  }

  const loadCredentials = async () => {
    if (!masterPassword) return
    try {
      setLoadingKeys(true)
      const result = await invoke<Credential[]>('get_credentials', { masterPassword })
      const sorted = [...result].sort((a, b) => {
        const providerCompare = a.provider.localeCompare(b.provider)
        if (providerCompare !== 0) return providerCompare
        return a.name.localeCompare(b.name)
      })
      setCredentials(sorted)
      setSelectedKey((prev) => (prev ? sorted.find((item) => item.id === prev.id) || null : null))

      const credentialIds = sorted.map((item) => item.id)
      if (!hasMigratedLegacyProjectLabels.current) {
        hasMigratedLegacyProjectLabels.current = true
        await migrateLegacyProjectLabels(credentialIds)
      }
      await loadProjectLabels(credentialIds)
    } catch (error) {
      console.error('Failed to load credentials:', error)
    } finally {
      setLoadingKeys(false)
    }
  }

  const loadProviders = async () => {
    if (!masterPassword) return
    try {
      setLoadingProviders(true)
      const result = await invoke<ProviderConfig[]>('get_providers', { masterPassword })
      setProviders(result)
      setSelectedProvider((prev) => {
        if (prev) {
          return result.find((item) => item.provider === prev.provider) || result[0] || null
        }
        return result[0] || null
      })
    } catch (error) {
      console.error('Failed to load providers:', error)
    } finally {
      setLoadingProviders(false)
    }
  }

  const loadCryptoWallets = async () => {
    if (!masterPassword) return
    try {
      setLoadingCryptoWallets(true)
      const result = await invoke<CryptoWallet[]>('get_crypto_wallets', { masterPassword })
      setCryptoWallets(result)
    } catch (error) {
      console.error('Failed to load crypto wallets:', error)
      setCryptoWallets([])
    } finally {
      setLoadingCryptoWallets(false)
    }
  }

  const loadProjects = async () => {
    if (!masterPassword) return
    try {
      const result = await invoke<Project[]>('get_projects', { masterPassword })
      setProjects(result)
    } catch (error) {
      console.error('Failed to load projects:', error)
      setProjects([])
    }
  }

  const handleProjectDataCleared = async () => {
    await Promise.all([loadProjects(), loadCredentials()])
    await loadProjectLabels()
    setProjectFocus(null)
  }

  const loadPrompts = async () => {
    if (!masterPassword) return
    try {
      setLoadingPrompts(true)
      const result = await invoke<PromptTemplateRecord[]>('get_prompts', { masterPassword })
      setPrompts(result)
      setSelectedPrompt((prev) => (prev ? result.find((item) => item.id === prev.id) || null : null))
    } catch (error) {
      console.error('Failed to load prompts:', error)
    } finally {
      setLoadingPrompts(false)
    }
  }

  const loadVoiceHistory = async () => {
    if (!masterPassword) return
    try {
      setLoadingVoiceHistory(true)
      setVoiceHistoryError(null)
      const result = await invoke<VoiceInputHistoryRecord[]>('get_voice_input_history', {
        masterPassword,
        limit: 200,
      })
      setVoiceHistory(result)
    } catch (error) {
      console.error('Failed to load voice history:', error)
      setVoiceHistory([])
      setVoiceHistoryError(String(error))
    } finally {
      setLoadingVoiceHistory(false)
    }
  }

  const loadDashboardOverview = async () => {
    if (!masterPassword) return
    try {
      const settings = await invoke<{ integrations: Array<{ app_type: string }> }>('get_global_settings', {
        masterPassword,
      })
      const appCount = settings.integrations.filter(
        (item) => item.app_type !== 'openai-compatible' && item.app_type !== 'claude'
      ).length
      setDashboardOverview((prev) => ({
        ...prev,
        apps: appCount,
      }))
    } catch (error) {
      console.error('Failed to load dashboard overview:', error)
      setDashboardOverview((prev) => ({ ...prev, apps: 0 }))
    }
  }

  useEffect(() => {
    invoke<boolean>('is_password_set')
      .then((isSet) => {
        setHasPassword(isSet)
      })
      .catch((error) => console.error('Error checking password:', error))
  }, [])

  useEffect(() => {
    if (!hasPassword) {
      setVaultUnlockState(null)
      return
    }

    invoke<VaultUnlockState>('get_vault_unlock_state')
      .then(setVaultUnlockState)
      .catch((error) => {
        console.error('Error checking vault unlock state:', error)
        setVaultUnlockState(null)
      })
  }, [hasPassword])

  useEffect(() => {
    if (isAuthenticated && masterPassword) {
      loadCredentials()
      loadProviders()
      loadCryptoWallets()
      loadProjects()
      loadPrompts()
      loadVoiceHistory()
      loadDashboardOverview()
    }
  }, [isAuthenticated, masterPassword])

  useEffect(() => {
    if (!isAuthenticated || !masterPassword) return
    if (view !== 'history') return
    loadVoiceHistory()
  }, [isAuthenticated, masterPassword, view])

  useEffect(() => {
    if (!isAuthenticated || !masterPassword) return
    invoke<boolean>('register_quick_hotkeys', { masterPassword }).catch((error) => {
      console.error('Failed to register quick hotkeys:', error)
    })
  }, [isAuthenticated, masterPassword])

  useEffect(() => {
    setDashboardOverview((prev) => ({
      ...prev,
      keys: credentials.length,
      cryptoWallets: cryptoWallets.length,
      providers: providers.length,
    }))
  }, [credentials.length, cryptoWallets.length, providers.length])

  const providerContextById = useMemo(
    () => buildProviderContextMap(credentials, projectLabelsByCredential, projects),
    [credentials, projectLabelsByCredential, projects]
  )
  const selectedKeyProvider = useMemo(() => {
    if (!selectedKey) return null
    return providers.find((item) => item.provider === selectedKey.provider) || null
  }, [providers, selectedKey])
  const selectedKeyProviderCategory = useMemo(() => {
    if (!selectedKey) return null
    return getProviderCategory(selectedKey.provider)
  }, [selectedKey])
  const selectedKeyProviderModels = useMemo(
    () => collectProviderModelNames(selectedKeyProvider),
    [selectedKeyProvider]
  )

  useEffect(() => {
    if (!isAuthenticated) return
    let timer: number | null = null

    const notifyIfNeeded = async (statuses: ProviderUsageStatus[]) => {
      const now = Date.now()
      const stored = loadStatusState()
      const updated: Record<string, { status: QuotaStatus; lastNotifiedAt: number }> = {
        ...stored,
      }

      for (const status of statuses) {
        if (!status.enabled || !status.snapshot || status.snapshot.quotas.length === 0) {
          continue
        }
        const minRemaining = Math.min(
          ...status.snapshot.quotas.map((quota) => quota.percent_remaining)
        )
        const currentStatus = evaluateStatus(minRemaining)
        const previous = stored[status.provider_id]
        const previousStatus = previous?.status
        const isWorse =
          previousStatus !== undefined &&
          statusOrder[currentStatus] > statusOrder[previousStatus]
        const cooldownPassed =
          !previous || now - (previous.lastNotifiedAt || 0) > NOTIFY_COOLDOWN_MS

        if (isWorse && cooldownPassed) {
          await sendSystemNotification(
            `${providerLabel(status.provider_id)} 用量提醒`,
            `状态已降级为 ${currentStatus.toUpperCase()}，剩余 ${Math.round(minRemaining)}%`
          )
          updated[status.provider_id] = { status: currentStatus, lastNotifiedAt: now }
        } else {
          updated[status.provider_id] = {
            status: currentStatus,
            lastNotifiedAt: previous?.lastNotifiedAt ?? 0,
          }
        }
      }

      saveStatusState(updated)
    }

    const refreshUsage = async () => {
      try {
        const result = await invoke<ProviderUsageStatus[]>('usage_refresh_all')
        await notifyIfNeeded(result)
      } catch (error) {
        console.warn('Usage refresh failed:', error)
      }
    }

    refreshUsage()
    timer = window.setInterval(refreshUsage, 120000)

    return () => {
      if (timer) window.clearInterval(timer)
    }
  }, [isAuthenticated])

  const handleSetPassword = async (password: string) => {
    try {
      await invoke('set_master_password', { password })
      setMasterPassword(password)
      setHasPassword(true)
      setAuthMethod('master-password')
      setIsAuthenticated(true)
    } catch (error) {
      console.error('Failed to set password:', error)
      alert('Failed to set password')
    }
  }

  const handleAuthenticate = async (password: string) => {
    try {
      const result = await invoke<boolean>('authenticate', { password })
      if (result) {
        setMasterPassword(password)
        setAuthMethod('master-password')
        setIsAuthenticated(true)
      } else {
        alert('Invalid password')
      }
    } catch (error) {
      console.error('Authentication failed:', error)
      alert('Authentication failed')
    }
  }

  const waitForPasskeyBridgeResult = async (token: string) => {
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 1000))
      // eslint-disable-next-line no-await-in-loop
      const result = await invoke<{ prfKeyHex: string } | null>('consume_passkey_browser_bridge_result', { token })
      if (result) return result
    }
    throw new Error('浏览器 passkey 操作超时。')
  }

  const handleAuthenticateWithPasskey = async () => {
    try {
      const state = await invoke<VaultUnlockState>('get_vault_unlock_state')
      const passkey = state.passkeys[0]
      if (!state.configured || !passkey) {
        alert('还没有可用的 passkey。请先用主密码登录，并在设置里添加 passkey。')
        return
      }
      let prfKeyHex: string
      if (isNativePasskey(passkey.rpId)) {
        // Native passkeys assert directly through AuthenticationServices — no
        // system-browser detour. (Runtime-blocked until the app is signed with
        // the Associated Domains entitlement.)
        const native = await assertNativePasskey(passkey.credentialId, passkey.prfSalt, passkey.rpId)
        prfKeyHex = native.prfKeyHex
      } else {
        const bridge = await invoke<PasskeyBridgeStart>('begin_passkey_browser_bridge', {
          mode: 'login',
          credentialId: passkey.credentialId,
          prfSalt: passkey.prfSalt,
          rpId: passkey.rpId,
        })
        await invoke<boolean>('open_external_url', { url: bridge.url })
        prfKeyHex = (await waitForPasskeyBridgeResult(bridge.token)).prfKeyHex
      }
      const result = await invoke<boolean>('authenticate_with_passkey_prf', { prfKeyHex })
      if (result) {
        setMasterPassword(prfKeyHex)
        setAuthMethod('passkey-prf')
        setIsAuthenticated(true)
      } else {
        alert('Passkey 解锁失败')
      }
    } catch (error) {
      console.error('Passkey authentication failed:', error)
      alert(`Passkey 解锁失败: ${String(error)}`)
    }
  }

  const handleAddKey = async (
    provider: string,
    name: string,
    key: string,
    source?: string,
    projectLabel?: string
  ) => {
    try {
      const created = await invoke<Credential>('add_credential', {
        provider,
        name,
        key,
        source,
        masterPassword,
      })
      const normalizedProject = normalizeProjectLabel(projectLabel)
      if (normalizedProject) {
        await invoke('set_credential_project_label', {
          credentialId: created.id,
          label: normalizedProject,
          masterPassword,
        })
        setProjectLabelsByCredential((prev) => ({
          ...prev,
          [created.id]: normalizedProject,
        }))
      }
      setShowForm(false)
      setSelectedKey(null)
      loadCredentials()
    } catch (error) {
      console.error('Failed to add credential:', error)
      alert(`Failed to add credential: ${String(error)}`)
    }
  }

  const handleUpdateKey = async (
    id: string,
    provider: string,
    name: string,
    key: string,
    projectLabel?: string
  ) => {
    try {
      await invoke('update_credential', {
        id,
        provider,
        name,
        key,
        masterPassword,
      })
      const normalizedProject = normalizeProjectLabel(projectLabel)
      await invoke('set_credential_project_label', {
        credentialId: id,
        label: normalizedProject ?? null,
        masterPassword,
      })
      setProjectLabelsByCredential((prev) => {
        const existing = prev[id]
        if (normalizedProject) {
          if (existing === normalizedProject) return prev
          return {
            ...prev,
            [id]: normalizedProject,
          }
        }
        if (!existing) return prev
        const { [id]: _removed, ...rest } = prev
        return rest
      })
      setShowForm(false)
      setSelectedKey(null)
      loadCredentials()
    } catch (error) {
      console.error('Failed to update credential:', error)
      alert(`Failed to update credential: ${String(error)}`)
    }
  }

  const handleDeleteKey = async (id: string) => {
    if (!confirm('确定要删除这个密钥吗？')) return

    try {
      await invoke('delete_credential', { id })
      setProjectLabelsByCredential((prev) => {
        if (!prev[id]) return prev
        const { [id]: _removed, ...rest } = prev
        return rest
      })
      setSelectedKey(null)
      loadCredentials()
    } catch (error) {
      console.error('Failed to delete credential:', error)
      alert(`Failed to delete credential: ${String(error)}`)
    }
  }

  const handleImportKeys = async (items: ParsedKey[]) => {
    if (!items.length) {
      alert('No keys selected for import')
      return
    }

    try {
      for (const item of items) {
        await invoke('add_credential', {
          provider: item.provider,
          name: item.name,
          key: item.key,
          source: item.source,
          masterPassword,
        })
      }
      setShowImport(false)
      loadCredentials()
    } catch (error) {
      console.error('Failed to import keys:', error)
      alert(`Failed to import keys: ${String(error)}`)
    }
  }

  const handleSaveProvider = async (
    provider: string,
    label: string,
    apiKey: string,
    baseUrl: string,
    models: string[],
    details?: ProviderDetails,
    endpoints?: ProviderEndpointInput[],
    envVars?: ProviderEnvVarInput[],
    appBindings?: ProviderAppBindingInput[]
  ) => {
    try {
      const result = await invoke<ProviderConfig>('upsert_provider', {
        provider,
        label,
        apiKey,
        baseUrl,
        models,
        details: details || DEFAULT_PROVIDER_DETAILS,
        endpoints,
        envVars,
        appBindings,
        masterPassword,
      })
      setProviders((prev) => {
        const exists = prev.some((item) => item.provider === result.provider)
        if (!exists) return [...prev, result]
        return prev.map((item) => (item.provider === result.provider ? result : item))
      })
      setSelectedProvider(result)
    } catch (error) {
      console.error('Failed to update provider:', error)
      alert(`Failed to update provider: ${String(error)}`)
    }
  }

  const handleToggleProviderActive = async (provider: string, isActive: boolean) => {
    try {
      const result = await invoke<ProviderConfig>('set_provider_active', {
        provider,
        isActive,
        masterPassword,
      })
      setProviders((prev) =>
        prev.map((item) => (item.provider === result.provider ? result : item))
      )
      setSelectedProvider((prev) =>
        prev?.provider === result.provider ? result : prev
      )
    } catch (error) {
      console.error('Failed to update provider active state:', error)
      alert(`Failed to update provider status: ${String(error)}`)
    }
  }

  const handleDeleteProvider = async (provider: string) => {
    try {
      await invoke<boolean>('delete_provider', {
        provider,
        masterPassword,
      })
      setProviders((prev) => {
        const next = prev.filter((item) => item.provider !== provider)
        setSelectedProvider((current) => {
          if (!current || current.provider !== provider) return current
          return next[0] || null
        })
        return next
      })
    } catch (error) {
      console.error('Failed to delete provider:', error)
      alert(`Failed to delete provider: ${String(error)}`)
    }
  }

  const copyTextToClipboard = async (value: string) => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value)
      return
    }
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.setAttribute('readonly', 'true')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(textarea)
    if (!copied) {
      throw new Error('Clipboard API unavailable')
    }
  }

  const handleCopyKey = async (credential: Credential) => {
    try {
      await copyTextToClipboard(credential.key)
      setCopiedKeyId(credential.id)
      window.setTimeout(() => {
        setCopiedKeyId((current) => (current === credential.id ? null : current))
      }, 1500)
    } catch (error) {
      console.error('Failed to copy key:', error)
      alert('复制密钥失败，请检查系统剪贴板权限')
    }
  }

  const handleCopyVoiceHistory = async (item: VoiceInputHistoryRecord) => {
    const text = (item.final_text || item.raw_text || '').trim()
    if (!text) return
    try {
      await copyTextToClipboard(text)
      setCopiedVoiceHistoryId(item.id)
      window.setTimeout(() => {
        setCopiedVoiceHistoryId((current) => (current === item.id ? null : current))
      }, 1500)
    } catch (error) {
      console.error('Failed to copy voice history:', error)
      alert('复制失败，请检查系统剪贴板权限')
    }
  }

  const handleDeleteVoiceHistory = async (id: string) => {
    if (!confirm('确定要删除这条历史记录吗？')) return
    try {
      const ok = await invoke<boolean>('delete_voice_input_history', { id, masterPassword })
      if (ok) {
        setVoiceHistory((prev) => prev.filter((item) => item.id !== id))
      }
    } catch (error) {
      console.error('Failed to delete voice history:', error)
      alert(`删除失败: ${String(error)}`)
    }
  }

  const navigateToProviderFromKey = (providerId: string) => {
    const target = providers.find((item) => item.provider === providerId)
    if (target) {
      setSelectedProvider(target)
    }
    setView('providers')
  }

  const navigateToProjectFromKey = (projectName: string) => {
    const normalized = projectName.trim()
    if (!normalized || normalized === UNMATCHED_PROJECT_NAME) return
    setProjectFocus({
      name: normalized,
      token: Date.now(),
    })
    setView('projects')
  }

  const handleSavePrompt = async (
    id: string | null,
    title: string,
    content: string,
    model: string,
    variables: string[]
  ) => {
    try {
      const result = await invoke<PromptTemplateRecord>('upsert_prompt', {
        id,
        title,
        content,
        model,
        variables,
        masterPassword,
      })
      setPrompts((prev) => {
        const exists = prev.find((item) => item.id === result.id)
        if (exists) {
          return prev.map((item) => (item.id === result.id ? result : item))
        }
        return [result, ...prev]
      })
      setSelectedPrompt(result)
    } catch (error) {
      console.error('Failed to save prompt:', error)
      alert(`Failed to save prompt: ${String(error)}`)
    }
  }

  const handleDeletePrompt = async (id: string) => {
    if (!confirm('确定要删除这个提示词吗？')) return
    try {
      await invoke('delete_prompt', { id, masterPassword })
      setPrompts((prev) => prev.filter((item) => item.id !== id))
      setSelectedPrompt(null)
    } catch (error) {
      console.error('Failed to delete prompt:', error)
      alert(`Failed to delete prompt: ${String(error)}`)
    }
  }

  if (!isAuthenticated) {
    return (
      <div className="auth-container">
        <div className="auth-card">
          <h1>MyKey</h1>
          <p>AI 资产保险箱</p>
          <AuthForm
            onSubmit={handleSetPassword}
            onAuthenticate={handleAuthenticate}
            onAuthenticateWithPasskey={handleAuthenticateWithPasskey}
            defaultMode={hasPassword ? 'login' : 'setup'}
            vaultUnlockState={vaultUnlockState}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <VoiceInputController masterPassword={masterPassword} />
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">MK</div>
          <div>
            <div className="brand-title">MyKey</div>
            <div className="brand-subtitle">Local AI Vault</div>
          </div>
        </div>
        <nav className="nav">
          {APP_NAV_ITEMS.map((item) => (
            <button
              key={item.view}
              className={`nav-item ${view === item.view ? 'active' : ''}`}
              onClick={() => setView(item.view)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <section className="app-content">
        <header className="content-header">
          <div>
            <h1>{VIEW_META[view].title}</h1>
            <p>{VIEW_META[view].description}</p>
          </div>
          {view === 'keys' && (
            <div className="header-actions">
              <button className="btn btn-primary" onClick={() => setShowForm(true)}>
                + 添加密钥
              </button>
              <button className="btn btn-secondary" onClick={() => setShowImport(true)}>
                批量导入
              </button>
            </div>
          )}
          {view === 'prompts' && (
            <div className="header-actions">
              <button
                className="btn btn-primary"
                onClick={() => {
                  setSelectedPrompt(null)
                }}
              >
                + 新建提示词
              </button>
            </div>
          )}
        </header>

        <main className="content-main">
          {view === 'dashboard' ? (
            <UsageDashboard
              providerContextById={providerContextById}
              masterPassword={masterPassword}
              quickStats={buildHomeQuickStats(dashboardOverview)}
              onNavigate={(nextView) => setView(nextView)}
            />
          ) : view === 'history' ? (
            <section className="panel voice-history-view">
              <div className="panel-header voice-history-header">
                <h2>语音输入历史</h2>
                <div className="header-actions">
                  <button
                    className="btn btn-secondary"
                    disabled={loadingVoiceHistory}
                    onClick={loadVoiceHistory}
                  >
                    {loadingVoiceHistory ? '刷新中...' : '刷新'}
                  </button>
                </div>
              </div>

              {voiceHistoryError ? (
                <div className="settings-item-subtitle">加载失败: {voiceHistoryError}</div>
              ) : null}

              {loadingVoiceHistory ? (
                <div className="panel-loading">加载中...</div>
              ) : voiceHistory.length === 0 ? (
                <div className="panel-empty">
                  <p>暂无语音输入历史记录</p>
                </div>
              ) : (
                <div className="voice-history-list">
                  {voiceHistory.map((item) => {
                    const text = (item.final_text || item.raw_text || '').trim()
                    const status = item.cancelled ? '已取消粘贴' : item.pasted ? '已粘贴' : '未粘贴'
                    return (
                      <div key={item.id} className="voice-history-item">
                        <div className="voice-history-item-header">
                          <div className="voice-history-meta">
                            <div className="voice-history-title">{status}</div>
                            <div className="voice-history-subtitle">
                              {new Date(item.created_at).toLocaleString()}
                              {item.trigger_mode ? ` · ${item.trigger_mode}` : ''}
                              {item.provider ? ` · ${item.provider}` : ''}
                              {item.model ? ` · ${item.model}` : ''}
                            </div>
                          </div>
                          <div className="voice-history-actions">
                            <button
                              className="btn btn-secondary"
                              disabled={!text}
                              onClick={() => handleCopyVoiceHistory(item)}
                            >
                              {copiedVoiceHistoryId === item.id ? '已复制' : '复制'}
                            </button>
                            <button
                              className="btn btn-secondary"
                              onClick={() => handleDeleteVoiceHistory(item.id)}
                            >
                              删除
                            </button>
                          </div>
                        </div>
                        <div className="voice-history-item-body">
                          <div className="voice-history-text">{text || '（空）'}</div>
                          {item.error ? (
                            <div className="voice-history-error">错误: {item.error}</div>
                          ) : null}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          ) : view === 'keys' ? (
            <div className="keys-view">
              <section className="panel">
                <div className="panel-header">
                  <h2>我的密钥</h2>
                  <span className="panel-count">{credentials.length}</span>
                </div>
                {loadingKeys ? (
                  <div className="panel-loading">加载中...</div>
                ) : credentials.length === 0 ? (
                  <div className="panel-empty">
                    <p>还没有添加任何密钥</p>
                    <button className="btn btn-primary" onClick={() => setShowForm(true)}>
                      添加第一个密钥
                    </button>
                  </div>
                ) : (
                  <KeyList
                    credentials={credentials}
                    projects={projects}
                    projectLabelsByCredential={projectLabelsByCredential}
                    selectedKey={selectedKey}
                    onSelectKey={setSelectedKey}
                    onCopyKey={handleCopyKey}
                    copiedKeyId={copiedKeyId}
                    onEditKey={(key) => {
                      setSelectedKey(key)
                      setShowForm(true)
                    }}
                    onDeleteKey={handleDeleteKey}
                    onNavigateToProvider={navigateToProviderFromKey}
                    onNavigateToProject={navigateToProjectFromKey}
                  />
                )}
              </section>

              <section className="panel detail-panel">
                <div className="panel-header">
                  <h2>密钥详情</h2>
                </div>
                {selectedKey ? (
                  <div className="key-details">
                    <div className="key-detail-hero">
                      <div>
                        <div className="key-detail-title">{selectedKey.name}</div>
                        <div className="key-detail-subtitle">{maskKey(selectedKey.key)}</div>
                      </div>
                      <div className="key-detail-chips">
                        <button
                          type="button"
                          className="detail-chip"
                          onClick={() => navigateToProviderFromKey(selectedKey.provider)}
                        >
                          {providerLabel(selectedKey.provider)}
                        </button>
                        <span className={`detail-chip ${selectedKey.is_active ? 'healthy' : 'warning'}`}>
                          {selectedKey.is_active ? '启用中' : '已停用'}
                        </span>
                      </div>
                    </div>

                    <div className="detail-section">
                      <div className="detail-section-title">基础信息</div>
                      <div className="detail-item-grid">
                        <div className="detail-item">
                          <label>提供商</label>
                          <button
                            type="button"
                            className="btn btn-link detail-link-btn"
                            onClick={() => navigateToProviderFromKey(selectedKey.provider)}
                          >
                            {providerLabel(selectedKey.provider)}
                          </button>
                        </div>
                        <div className="detail-item">
                          <label>名称</label>
                          <p>{selectedKey.name}</p>
                        </div>
                      </div>
                    </div>

                    <div className="detail-section">
                      <div className="detail-section-title">关联与状态</div>
                      <div className="detail-item-grid">
                        <div className="detail-item">
                          <label>项目</label>
                          {(() => {
                            const projectName = resolveProjectLabel(
                              selectedKey,
                              projectLabelsByCredential,
                              projects
                            )
                            if (projectName === UNMATCHED_PROJECT_NAME) {
                              return <p>{projectName}</p>
                            }
                            return (
                              <button
                                type="button"
                                className="btn btn-link detail-link-btn"
                                onClick={() => navigateToProjectFromKey(projectName)}
                              >
                                {projectName}
                              </button>
                            )
                          })()}
                        </div>
                        <div className="detail-item">
                          <label>创建时间</label>
                          <p>{new Date(selectedKey.created_at).toLocaleString()}</p>
                        </div>
                      </div>
                    </div>

                    <div className="detail-section">
                      <div className="detail-section-title">服务商配置</div>
                      <div className="detail-item-grid">
                        <div className="detail-item">
                          <label>服务类型</label>
                          <p>
                            {selectedKeyProviderCategory
                              ? getProviderCategoryLabel(selectedKeyProviderCategory)
                              : '未知'}
                          </p>
                        </div>
                        <div className="detail-item">
                          <label>模型数量</label>
                          <p>{selectedKeyProviderModels.length}</p>
                        </div>
                      </div>
                      <div className="detail-item">
                        <label>模型列表</label>
                        {selectedKeyProviderModels.length > 0 ? (
                          <div className="detail-model-tags">
                            {selectedKeyProviderModels.map((model) => (
                              <span key={model} className="detail-model-tag">
                                {model}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <p className="detail-item-subtle">
                            {selectedKeyProviderCategory === 'translation' || selectedKeyProviderCategory === 'ocr'
                              ? '当前服务商未配置模型（翻译/OCR 通常可直接按接口调用）。'
                              : '当前服务商未配置模型。'}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="detail-section">
                      <div className="detail-section-title">来源与操作</div>
                      {selectedKey.source ? (
                        <div className="detail-item">
                          <label>来源路径</label>
                          <p>{selectedKey.source}</p>
                        </div>
                      ) : (
                        <div className="detail-item">
                          <label>来源路径</label>
                          <p>手动录入</p>
                        </div>
                      )}
                      <div className="detail-actions-row">
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => handleCopyKey(selectedKey)}
                        >
                          {copiedKeyId === selectedKey.id ? '已复制' : '复制密钥'}
                        </button>
                        <button className="btn btn-primary" onClick={() => setShowForm(true)}>
                          编辑密钥
                        </button>
                        {(() => {
                          const projectName = resolveProjectLabel(
                            selectedKey,
                            projectLabelsByCredential,
                            projects
                          )
                          if (projectName === UNMATCHED_PROJECT_NAME) return null
                          return (
                            <button
                              type="button"
                              className="btn btn-secondary"
                              onClick={() => navigateToProjectFromKey(projectName)}
                            >
                              打开项目
                            </button>
                          )
                        })()}
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => navigateToProviderFromKey(selectedKey.provider)}
                        >
                          打开提供商
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="panel-empty">
                    <p>选择一个密钥查看详情</p>
                  </div>
                )}
              </section>
            </div>
          ) : view === 'projects' ? (
            <ProjectManager
              credentials={credentials}
              projects={projects}
              projectLabelsByCredential={projectLabelsByCredential}
              masterPassword={masterPassword}
              focusProjectName={projectFocus?.name}
              focusProjectToken={projectFocus?.token}
              onProjectsChanged={setProjects}
              onProjectDataCleared={handleProjectDataCleared}
              onError={(msg) => alert(msg)}
            />
          ) : view === 'providers' ? (
            <ProviderManager
              providers={providers}
              selectedProvider={selectedProvider}
              onSelectProvider={setSelectedProvider}
              onSaveProvider={handleSaveProvider}
              onToggleProviderActive={handleToggleProviderActive}
              onDeleteProvider={handleDeleteProvider}
              credentials={credentials}
              projects={projects}
              projectLabelsByCredential={projectLabelsByCredential}
              loading={loadingProviders}
            />
          ) : view === 'crypto' ? (
            <CryptoWalletManager
              masterPassword={masterPassword}
              wallets={cryptoWallets}
              loading={loadingCryptoWallets}
              onWalletsChanged={setCryptoWallets}
              onRefresh={loadCryptoWallets}
              onError={(msg) => alert(msg)}
            />
          ) : view === 'apps' ? (
            <ApplicationManager
              masterPassword={masterPassword}
              providers={providers}
            />
          ) : view === 'mcp' ? (
            <OpencodeMcpManager masterPassword={masterPassword} />
          ) : view === 'skills' ? (
            <OpencodeSkillManager masterPassword={masterPassword} />
          ) : view === 'compute' ? (
            <ComputeGatewayManager masterPassword={masterPassword} providers={providers} />
          ) : view === 'settings' ? (
            <GlobalSettings
              masterPassword={masterPassword}
              authMethod={authMethod}
              onProjectDataCleared={handleProjectDataCleared}
            />
          ) : (
            <PromptManager
              prompts={prompts}
              selectedPrompt={selectedPrompt}
              onSelectPrompt={setSelectedPrompt}
              onSavePrompt={handleSavePrompt}
              onDeletePrompt={handleDeletePrompt}
              loading={loadingPrompts}
            />
          )}
        </main>
      </section>

      {showForm && (
        <KeyForm
          key={selectedKey?.id}
          credential={selectedKey}
          initialProjectLabel={selectedKey ? projectLabelsByCredential[selectedKey.id] : ''}
          providers={providers}
          onSave={(provider, name, key, projectLabel) => {
            if (selectedKey) {
              handleUpdateKey(selectedKey.id, provider, name, key, projectLabel)
            } else {
              handleAddKey(provider, name, key, undefined, projectLabel)
            }
          }}
          onCancel={() => {
            setShowForm(false)
            setSelectedKey(null)
          }}
        />
      )}

      {showImport && (
        <ImportModal
          masterPassword={masterPassword}
          onImport={handleImportKeys}
          onCancel={() => setShowImport(false)}
        />
      )}

      <ClippyAssistant masterPassword={masterPassword} />
    </div>
  )
}

interface AuthFormProps {
  onSubmit: (password: string) => void
  onAuthenticate: (password: string) => void
  onAuthenticateWithPasskey: () => void
  defaultMode: 'setup' | 'login'
  vaultUnlockState: VaultUnlockState | null
}

function AuthForm({
  onSubmit,
  onAuthenticate,
  onAuthenticateWithPasskey,
  defaultMode,
  vaultUnlockState,
}: AuthFormProps) {
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'setup' | 'login'>(defaultMode)

  useEffect(() => {
    setMode(defaultMode)
  }, [defaultMode])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (mode === 'setup') {
      onSubmit(password)
    } else {
      onAuthenticate(password)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="auth-form">
      <input
        type="password"
        placeholder="主密码"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      <button type="submit" className="btn btn-primary">
        {mode === 'setup' ? '设置密码' : '登录'}
      </button>
      {shouldShowVaultPasskeyLogin(mode, vaultUnlockState) ? (
        <button type="button" className="btn btn-secondary" onClick={onAuthenticateWithPasskey}>
          使用 Passkey 登录
        </button>
      ) : null}
      <button
        type="button"
        className="btn btn-link"
        onClick={() => setMode(mode === 'setup' ? 'login' : 'setup')}
      >
        {mode === 'setup' ? '已有账户？登录' : '首次使用？设置密码'}
      </button>
    </form>
  )
}

const maskKey = (value: string) => {
  if (!value) return ''
  if (value.length <= 12) return value
  return `${value.slice(0, 8)}...${value.slice(-6)}`
}

export default App
