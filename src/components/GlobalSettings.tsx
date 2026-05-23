import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import './GlobalSettings.css'
import {
  GatewayTrafficMetrics,
  GatewayPolicySettings,
  GatewayRequestLog,
  GlobalSettingsPayload,
  MacosPermissionStatus,
  QuickActionSettings,
  ServiceConfig,
  VoiceInputDiagnostics,
  VoiceInputSettings,
  RecentDebugLogs,
} from '../types/settings'
import type { ProviderConfig } from '../types/provider'
import { getProviderCategory } from '../utils/provider'
import { suppressProjectAutoScanOnce } from '../utils/project'
import { createVaultPasskeyPrfKey, isPasskeyPrfAvailable } from '../utils/passkeyPrf'
import { isNativePasskeyAvailable, registerNativePasskey } from '../utils/passkeyNative'
import {
  canEnableBiometricKeychain,
  canRegisterVaultPasskey,
  classifyPasskeyError,
  describeVaultUnlockState,
  type VaultAuthMethod,
  type VaultUnlockState,
} from '../utils/vaultUnlock'

interface GlobalSettingsProps {
  masterPassword: string
  authMethod: VaultAuthMethod
  onProjectDataCleared?: () => Promise<void> | void
}

const integrationLabels: Record<string, string> = {
  claude: 'Claude Code',
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
  'openai-compatible': 'OpenAI Compatible',
}

const serviceLabels: Record<string, string> = {
  gateway: 'Gateway',
  'usage-probe': 'Usage Probe',
}

const serviceDescriptions: Record<string, string> = {
  gateway: '本地代理入口服务，负责统一转发与注入凭证。',
  'usage-probe': '用量探针服务，负责采集本地账号与配额快照。',
}

interface ScannedProject {
  id: string
  name: string
  path: string
}

interface OnePasswordProjectSyncResult {
  project_id: string
  project_name: string
  project_path: string
  detected_keys: number
  success_keys: number
  failed_keys: number
  restored_file?: string | null
  message?: string | null
}

interface OnePasswordSyncSummary {
  vault: string
  env: string
  total_projects: number
  processed_projects: number
  skipped_projects: number
  total_keys: number
  success_keys: number
  failed_keys: number
  results: OnePasswordProjectSyncResult[]
}

interface PasskeyBridgeStart {
  token: string
  url: string
}

type ProjectSyncNoticeLevel = 'info' | 'success' | 'error'
const GATEWAY_TRAFFIC_WINDOWS = [
  { label: '15 分钟', value: 15 },
  { label: '1 小时', value: 60 },
  { label: '6 小时', value: 360 },
  { label: '24 小时', value: 1440 },
]

export default function GlobalSettings({ masterPassword, authMethod, onProjectDataCleared }: GlobalSettingsProps) {
  const [settings, setSettings] = useState<GlobalSettingsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [backupMessage, setBackupMessage] = useState<string>('')
  const [restoreMessage, setRestoreMessage] = useState<string>('')
  const [deleteBackupMessage, setDeleteBackupMessage] = useState<string>('')
  const [clearProjectMessage, setClearProjectMessage] = useState<string>('')
  const [portDrafts, setPortDrafts] = useState<Record<string, string>>({})
  const [gatewayPolicy, setGatewayPolicy] = useState<GatewayPolicySettings | null>(null)
  const [gatewayLogs, setGatewayLogs] = useState<GatewayRequestLog[]>([])
  const [gatewayTraffic, setGatewayTraffic] = useState<GatewayTrafficMetrics | null>(null)
  const [gatewayTrafficWindow, setGatewayTrafficWindow] = useState<number>(60)
  const [budgetDraft, setBudgetDraft] = useState<string>('')
  const [scannedProjects, setScannedProjects] = useState<ScannedProject[]>([])
  const [projectSyncVault, setProjectSyncVault] = useState('mykey')
  const [projectSyncEnv, setProjectSyncEnv] = useState('dev')
  const [projectSyncResult, setProjectSyncResult] = useState<OnePasswordSyncSummary | null>(null)
  const [projectSyncNotice, setProjectSyncNotice] = useState<{ level: ProjectSyncNoticeLevel; text: string } | null>(
    null
  )
  const [quickSettings, setQuickSettings] = useState<QuickActionSettings | null>(null)
  const [quickProviders, setQuickProviders] = useState<ProviderConfig[]>([])
  const [quickSaveMessage, setQuickSaveMessage] = useState<string>('')
  const [voiceSettings, setVoiceSettings] = useState<VoiceInputSettings | null>(null)
  const [voiceDiagnostics, setVoiceDiagnostics] = useState<VoiceInputDiagnostics | null>(null)
  const [voiceSaveMessage, setVoiceSaveMessage] = useState<string>('')
  const [macPerm, setMacPerm] = useState<MacosPermissionStatus | null>(null)
  const [voiceSelfTestMessage, setVoiceSelfTestMessage] = useState<string>('')
  const [debugLogs, setDebugLogs] = useState<RecentDebugLogs | null>(null)
  const [vaultUnlockState, setVaultUnlockState] = useState<VaultUnlockState | null>(null)
  const [biometricKeychainConfigured, setBiometricKeychainConfigured] = useState(false)
  const [biometricKeychainAvailable, setBiometricKeychainAvailable] = useState(false)
  const [vaultUnlockMessage, setVaultUnlockMessage] = useState<string>('')
  const refreshSeqRef = useRef(0)

  const services = settings?.services ?? []
  const integrations = settings?.integrations ?? []
  const gatewayService = services.find((item) => item.service_name === 'gateway')
  const gatewayBaseUrl = `http://127.0.0.1:${gatewayService?.port || 8888}`
  const vaultUnlockLabels = vaultUnlockState ? describeVaultUnlockState(vaultUnlockState) : null

  const refresh = async (showLoading = true, windowMinutes = gatewayTrafficWindow) => {
    if (!masterPassword) return
    const seq = (refreshSeqRef.current += 1)
    try {
      if (showLoading) {
        setLoading(true)
      }
      setError(null)

      const payload = await invoke<GlobalSettingsPayload>('get_global_settings', {
        masterPassword,
      })
      if (seq !== refreshSeqRef.current) return
      setSettings(payload)

      if (showLoading) {
        setLoading(false)
      }

      ;(async () => {
        const results = await Promise.allSettled([
          invoke<GatewayPolicySettings>('get_gateway_policy_settings', {
            masterPassword,
          }),
          invoke<GatewayRequestLog[]>('get_gateway_request_logs', {
            limit: 80,
            masterPassword,
          }),
          invoke<GatewayTrafficMetrics>('get_gateway_traffic_metrics', {
            windowMinutes,
            masterPassword,
          }),
          invoke<QuickActionSettings>('get_quick_action_settings', {
            masterPassword,
          }),
          invoke<ProviderConfig[]>('get_providers', { masterPassword }),
          invoke<VoiceInputSettings>('get_voice_input_settings', { masterPassword }),
          invoke<VoiceInputDiagnostics>('get_voice_input_diagnostics', { masterPassword }),
          invoke<MacosPermissionStatus>('get_macos_permission_status'),
          invoke<VaultUnlockState>('get_vault_unlock_state'),
          invoke<boolean>('biometric_keychain_available'),
          invoke<boolean>('biometric_keychain_configured'),
        ])

        if (seq !== refreshSeqRef.current) return

        const errors: string[] = []
        const settledValue = <T,>(idx: number): T | null => {
          const item = results[idx]
          if (item.status === 'fulfilled') return item.value as T
          errors.push(String(item.reason))
          return null
        }

        const policy = settledValue<GatewayPolicySettings>(0)
        const logs = settledValue<GatewayRequestLog[]>(1)
        const traffic = settledValue<GatewayTrafficMetrics>(2)
        const quick = settledValue<QuickActionSettings>(3)
        const providers = settledValue<ProviderConfig[]>(4)
        const voice = settledValue<VoiceInputSettings>(5)
        const voiceDiag = settledValue<VoiceInputDiagnostics>(6)
        const perm = settledValue<MacosPermissionStatus>(7)
        const unlockState = settledValue<VaultUnlockState>(8)
        const biometricAvailable = settledValue<boolean>(9)
        const biometricConfigured = settledValue<boolean>(10)

        if (policy) {
          setGatewayPolicy(policy)
          setBudgetDraft(policy.daily_budget_usd ? policy.daily_budget_usd.toFixed(2) : '')
        }
        if (logs) setGatewayLogs(logs)
        if (traffic) setGatewayTraffic(traffic)
        if (quick) setQuickSettings(quick)
        if (providers) setQuickProviders(providers)
        if (voice) setVoiceSettings(voice)
        if (voiceDiag) setVoiceDiagnostics(voiceDiag)
        if (perm) setMacPerm(perm)
        if (unlockState) setVaultUnlockState(unlockState)
        setBiometricKeychainAvailable(Boolean(biometricAvailable))
        setBiometricKeychainConfigured(Boolean(biometricAvailable && biometricConfigured))

        if (errors.length > 0) {
          setError(`部分信息加载失败：${errors[0]}`)
        }
      })().catch((err) => {
        if (seq !== refreshSeqRef.current) return
        setError(`部分信息加载失败：${String(err)}`)
      })
    } catch (err) {
      console.error('Failed to load global settings:', err)
      setError(`无法加载全局设置：${String(err)}`)
    } finally {
      if (showLoading) {
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    refresh(true, gatewayTrafficWindow)
  }, [masterPassword])

  useEffect(() => {
    if (!masterPassword) return
    refresh(false, gatewayTrafficWindow)
  }, [gatewayTrafficWindow, masterPassword])

  useEffect(() => {
    if (!masterPassword) return
    invoke<ScannedProject[]>('get_projects', { masterPassword })
      .then((projects) => setScannedProjects(projects))
      .catch((error) => {
        console.error('Failed to load scanned projects:', error)
        setScannedProjects([])
      })
  }, [masterPassword])

  useEffect(() => {
    const next: Record<string, string> = {}
    for (const service of services) {
      next[service.service_name] = service.port ? String(service.port) : ''
    }
    setPortDrafts(next)
  }, [settings?.services])

  const activeIntegrations = useMemo(
    () => integrations.filter((item) => item.enabled).length,
    [integrations]
  )

  const activeServices = useMemo(
    () => services.filter((item) => item.enabled).length,
    [services]
  )
  const gatewaySuccessRate = useMemo(() => {
    if (!gatewayTraffic || gatewayTraffic.total_requests <= 0) return 0
    return (gatewayTraffic.success_requests / gatewayTraffic.total_requests) * 100
  }, [gatewayTraffic])
  const gatewayErrorRate = useMemo(() => {
    if (!gatewayTraffic || gatewayTraffic.total_requests <= 0) return 0
    return (
      ((gatewayTraffic.client_error_requests + gatewayTraffic.server_error_requests) /
        gatewayTraffic.total_requests) *
      100
    )
  }, [gatewayTraffic])
  const translateProviderOptions = useMemo(
    () => quickProviders.filter((item) => getProviderCategory(item.provider) === 'translation'),
    [quickProviders]
  )
  const ocrProviderOptions = useMemo(
    () => quickProviders.filter((item) => getProviderCategory(item.provider) === 'ocr'),
    [quickProviders]
  )
  const sttProviderOptions = useMemo(() => {
    return quickProviders.filter((item) => {
      if (item.provider === 'openai') return true
      return getProviderCategory(item.provider) === 'speech_to_text'
    })
  }, [quickProviders])

  const voiceLanguagePresets = useMemo(
    () => [
      { value: 'zh', label: '中文 (zh)' },
      { value: 'auto', label: '自动检测 (auto)' },
      { value: 'en', label: 'English (en)' },
      { value: 'ja', label: '日本語 (ja)' },
    ],
    []
  )
  const shipkeyBusy = busyKey?.startsWith('project-sync:') ?? false
  const shipkeyScanPreviewBusy = busyKey === 'project-sync:backup'
  const shipkeyScanWriteBusy = busyKey === 'project-sync:restore'
  const shipkeyBusyLabel = useMemo(() => {
    switch (busyKey) {
      case 'project-sync:backup':
        return '正在备份已扫描项目到 1Password...'
      case 'project-sync:restore':
        return '正在从 1Password 恢复到项目...'
      default:
        return ''
    }
  }, [busyKey])

  const backupProjectsToOnePassword = async () => {
    if (shipkeyBusy) return
    if (scannedProjects.length === 0) {
      setProjectSyncNotice({
        level: 'error',
        text: '当前没有已扫描项目，请先到“项目”页面执行自动扫描。',
      })
      return
    }
    setProjectSyncResult(null)
    setProjectSyncNotice({ level: 'info', text: '开始备份到 1Password...' })
    setBusyKey('project-sync:backup')
    try {
      const result = await invoke<OnePasswordSyncSummary>('backup_scanned_projects_to_onepassword', {
        vaultName: projectSyncVault,
        env: projectSyncEnv,
        masterPassword,
      })
      setProjectSyncResult(result)
      setProjectSyncNotice({
        level: result.failed_keys > 0 ? 'error' : 'success',
        text:
          result.failed_keys > 0
            ? `备份完成，但有 ${result.failed_keys} 个密钥失败。`
            : `备份完成，成功写入 ${result.success_keys} 个密钥。`,
      })
    } catch (err) {
      console.error(err)
      setProjectSyncResult(null)
      setProjectSyncNotice({
        level: 'error',
        text: `备份失败: ${String(err)}`,
      })
    } finally {
      setBusyKey(null)
    }
  }

  const restoreProjectsFromOnePassword = async () => {
    if (shipkeyBusy) return
    if (scannedProjects.length === 0) {
      setProjectSyncNotice({
        level: 'error',
        text: '当前没有已扫描项目，请先到“项目”页面执行自动扫描。',
      })
      return
    }
    if (!confirm('将把 1Password 中对应项目密钥写回项目目录的 .env.local/.dev.vars，是否继续？')) {
      return
    }
    setProjectSyncResult(null)
    setProjectSyncNotice({ level: 'info', text: '开始从 1Password 恢复到项目...' })
    setBusyKey('project-sync:restore')
    try {
      const result = await invoke<OnePasswordSyncSummary>('restore_scanned_projects_from_onepassword', {
        vaultName: projectSyncVault,
        env: projectSyncEnv,
        masterPassword,
      })
      setProjectSyncResult(result)
      setProjectSyncNotice({
        level: result.failed_keys > 0 ? 'error' : 'success',
        text:
          result.failed_keys > 0
            ? `恢复完成，但有 ${result.failed_keys} 个密钥失败。`
            : `恢复完成，成功写回 ${result.success_keys} 个密钥。`,
      })
    } catch (err) {
      console.error(err)
      setProjectSyncResult(null)
      setProjectSyncNotice({
        level: 'error',
        text: `恢复失败: ${String(err)}`,
      })
    } finally {
      setBusyKey(null)
    }
  }

  const updateIntegration = async (appType: string, enabled: boolean) => {
    setBusyKey(`integration:${appType}`)
    try {
      await invoke('set_global_integration_enabled', {
        appType,
        enabled,
        masterPassword,
      })
      await refresh(false)
    } catch (err) {
      console.error(err)
      alert(`更新集成状态失败: ${String(err)}`)
    } finally {
      setBusyKey(null)
    }
  }

  const updateServiceEnabled = async (serviceName: string, enabled: boolean) => {
    setBusyKey(`service-enabled:${serviceName}`)
    try {
      await invoke('set_global_service_enabled', {
        serviceName,
        enabled,
        masterPassword,
      })
      await refresh(false)
    } catch (err) {
      console.error(err)
      alert(`更新服务状态失败: ${String(err)}`)
    } finally {
      setBusyKey(null)
    }
  }

  const updateServiceAutoStart = async (serviceName: string, autoStart: boolean) => {
    setBusyKey(`service-auto:${serviceName}`)
    try {
      await invoke('set_global_service_auto_start', {
        serviceName,
        autoStart,
        masterPassword,
      })
      await refresh(false)
    } catch (err) {
      console.error(err)
      alert(`更新自动启动失败: ${String(err)}`)
    } finally {
      setBusyKey(null)
    }
  }

  const saveServicePort = async (service: ServiceConfig) => {
    const raw = (portDrafts[service.service_name] ?? '').trim()
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      alert('端口必须是 1-65535 的整数')
      return
    }

    setBusyKey(`service-port:${service.service_name}`)
    try {
      await invoke('set_global_service_port', {
        serviceName: service.service_name,
        port: value,
        masterPassword,
      })
      await refresh(false)
    } catch (err) {
      console.error(err)
      alert(`保存端口失败: ${String(err)}`)
    } finally {
      setBusyKey(null)
    }
  }

  const toggleDebug = async (enabled: boolean) => {
    setBusyKey('debug-mode')
    try {
      await invoke('set_global_debug_mode', {
        enabled,
        masterPassword,
      })
      await refresh(false)
    } catch (err) {
      console.error(err)
      alert(`更新 Debug 模式失败: ${String(err)}`)
    } finally {
      setBusyKey(null)
    }
  }

  const toggleCircuitBreaker = async (enabled: boolean) => {
    setBusyKey('gateway-circuit-breaker')
    try {
      await invoke('set_gateway_circuit_breaker', {
        enabled,
        masterPassword,
      })
      await refresh(false)
    } catch (err) {
      console.error(err)
      alert(`更新全局熔断失败: ${String(err)}`)
    } finally {
      setBusyKey(null)
    }
  }

  const saveDailyBudget = async () => {
    const raw = budgetDraft.trim()
    let parsedBudget: number | null = null
    if (raw.length > 0) {
      const value = Number(raw)
      if (!Number.isFinite(value) || value <= 0) {
        alert('预算必须是大于 0 的数字，留空表示不限制')
        return
      }
      parsedBudget = value
    }

    setBusyKey('gateway-daily-budget')
    try {
      await invoke('set_gateway_daily_budget', {
        dailyBudgetUsd: parsedBudget,
        masterPassword,
      })
      await refresh(false)
    } catch (err) {
      console.error(err)
      alert(`保存每日预算失败: ${String(err)}`)
    } finally {
      setBusyKey(null)
    }
  }

  const refreshGatewayTraffic = async () => {
    setBusyKey('gateway-traffic-refresh')
    try {
      await refresh(false, gatewayTrafficWindow)
    } finally {
      setBusyKey(null)
    }
  }

  const createBackup = async () => {
    setBusyKey('backup-now')
    setRestoreMessage('')
    setDeleteBackupMessage('')
    try {
      const backupPath = await invoke<string>('backup_now', {
        targetDir: null,
        masterPassword,
      })
      setBackupMessage(`备份已创建: ${backupPath}`)
      await refresh(false)
    } catch (err) {
      console.error(err)
      alert(`创建备份失败: ${String(err)}`)
    } finally {
      setBusyKey(null)
    }
  }

  const restoreBackup = async () => {
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: 'SQLite Backup', extensions: ['db', 'sqlite', 'sqlite3'] }],
    })
    if (!selected || Array.isArray(selected)) {
      return
    }
    if (!confirm('恢复备份会覆盖当前数据（保留当前主密码）。确定继续吗？')) {
      return
    }

    setBusyKey('backup-restore')
    setBackupMessage('')
    setDeleteBackupMessage('')
    try {
      await invoke<boolean>('restore_backup', {
        backupPath: selected,
        masterPassword,
      })
      setRestoreMessage(`已恢复备份: ${selected}`)
      await refresh(false)
    } catch (err) {
      console.error(err)
      alert(`恢复备份失败: ${String(err)}`)
    } finally {
      setBusyKey(null)
    }
  }

  const deleteBackup = async () => {
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: 'SQLite Backup', extensions: ['db', 'sqlite', 'sqlite3'] }],
    })
    if (!selected || Array.isArray(selected)) {
      return
    }
    if (!confirm(`确定删除备份文件吗？\n${selected}`)) {
      return
    }

    setBusyKey('backup-delete')
    setBackupMessage('')
    setRestoreMessage('')
    try {
      await invoke<boolean>('delete_backup', {
        backupPath: selected,
        masterPassword,
      })
      setDeleteBackupMessage(`已删除备份: ${selected}`)
      await refresh(false)
    } catch (err) {
      console.error(err)
      alert(`删除备份失败: ${String(err)}`)
    } finally {
      setBusyKey(null)
    }
  }

  const clearProjectData = async () => {
    if (
      !confirm('清除项目数据会删除项目列表、项目绑定、项目作用域工具绑定，并清空密钥来源与项目标签。\n此操作不会删除密钥本身。确定继续吗？')
    ) {
      return
    }

    setBusyKey('project-clear')
    setProjectSyncResult(null)
    setProjectSyncNotice(null)
    setClearProjectMessage('')
    try {
      await invoke<boolean>('clear_project_data', {
        masterPassword,
      })
      suppressProjectAutoScanOnce()
      setScannedProjects([])
      await onProjectDataCleared?.()
      setClearProjectMessage('项目数据已清除，可重新开始配置项目。')
      await refresh(false)
    } catch (err) {
      console.error(err)
      alert(`清除项目数据失败: ${String(err)}`)
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

  const waitForPasskeyBridgeResult = async (token: string) => {
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 1000))
      // eslint-disable-next-line no-await-in-loop
      const result = await invoke<{
        credentialId: string
        userId: string
        rpId: string
        prfSalt: string
        prfKeyHex: string
      } | null>('consume_passkey_browser_bridge_result', { token })
      if (result) return result
    }
    throw new Error('浏览器 passkey 操作超时。')
  }

  const createVaultPasskeyWithBrowserBridge = async () => {
    const bridge = await invoke<PasskeyBridgeStart>('begin_passkey_browser_bridge', {
      mode: 'register',
      credentialId: null,
      prfSalt: null,
      rpId: null,
    })
    await invoke<boolean>('open_external_url', { url: bridge.url })
    setVaultUnlockMessage('已打开系统浏览器，请在那里完成 passkey，然后回到 MyKey。')
    return waitForPasskeyBridgeResult(bridge.token)
  }

  const addVaultPasskey = async () => {
    if (!vaultUnlockState?.configured) {
      setVaultUnlockMessage('Vault 加密状态还未初始化，请先用主密码重新登录一次。')
      return
    }
    if (authMethod !== 'master-password') {
      setVaultUnlockMessage('新增 passkey 需要主密码会话。请退出后用主密码登录，再添加 passkey。')
      return
    }
    if (!isPasskeyPrfAvailable()) {
      setVaultUnlockMessage('当前 WebView 不支持 WebAuthn PRF，无法创建 passkey。')
      return
    }

    setBusyKey('vault-passkey')
    setVaultUnlockMessage('')
    try {
      let passkey: {
        credentialId: string
        userId: string
        rpId: string
        prfSalt: string
        prfKeyHex: string
      }
      // Prefer the native macOS passkey (real RP domain). It is runtime-blocked
      // until the app is signed with the Associated Domains entitlement, so any
      // failure falls through to the in-WebView / browser-bridge paths that work
      // today against localhost.
      const nativeReady = await isNativePasskeyAvailable()
      let nativePasskey: typeof passkey | null = null
      if (nativeReady) {
        try {
          setVaultUnlockMessage('正在通过系统原生 passkey 创建…')
          nativePasskey = await registerNativePasskey('MyKey Vault')
        } catch (err) {
          console.warn('native passkey register failed, falling back to browser bridge:', err)
          setVaultUnlockMessage('')
        }
      }

      if (nativePasskey) {
        passkey = nativePasskey
      } else {
        try {
          passkey = await createVaultPasskeyPrfKey('MyKey Vault')
        } catch (err) {
          const classified = classifyPasskeyError(err)
          if (!classified.canUseBrowserBridge) throw err
          passkey = await createVaultPasskeyWithBrowserBridge()
        }
      }
      await invoke<boolean>('add_passkey_prf_unlock_method', {
        masterPassword,
        rpId: passkey.rpId || window.location.hostname || 'localhost',
        userId: passkey.userId,
        credentialId: passkey.credentialId,
        prfSalt: passkey.prfSalt,
        prfKeyHex: passkey.prfKeyHex,
      })
      const nextState = await invoke<VaultUnlockState>('get_vault_unlock_state')
      setVaultUnlockState(nextState)
      setVaultUnlockMessage('Passkey 已添加。下次登录可选择主密码或 passkey 解锁。')
    } catch (err) {
      console.error(err)
      setVaultUnlockMessage(`添加 passkey 失败: ${String(err)}`)
    } finally {
      setBusyKey(null)
    }
  }

  const enableBiometricKeychain = async () => {
    if (!canEnableBiometricKeychain(authMethod, vaultUnlockState, busyKey === 'biometric-keychain')) {
      setVaultUnlockMessage('Touch ID 快速解锁需要先用主密码登录，并初始化 vault 加密。')
      return
    }

    setBusyKey('biometric-keychain')
    setVaultUnlockMessage('')
    try {
      await invoke<boolean>('enable_biometric_keychain_unlock', { masterPassword })
      setBiometricKeychainConfigured(true)
      setVaultUnlockMessage('Touch ID 快速解锁已启用。下次登录可使用系统验证解锁。')
    } catch (err) {
      console.error(err)
      setVaultUnlockMessage(`启用 Touch ID 失败: ${String(err)}`)
    } finally {
      setBusyKey(null)
    }
  }

  const removeBiometricKeychain = async () => {
    setBusyKey('biometric-keychain')
    setVaultUnlockMessage('')
    try {
      await invoke<boolean>('remove_biometric_keychain_unlock')
      setBiometricKeychainConfigured(false)
      setVaultUnlockMessage('Touch ID 快速解锁已关闭。')
    } catch (err) {
      console.error(err)
      setVaultUnlockMessage(`关闭 Touch ID 失败: ${String(err)}`)
    } finally {
      setBusyKey(null)
    }
  }

  const saveQuickActionSettings = async () => {
    if (!quickSettings) return
    setBusyKey('quick-settings')
    setQuickSaveMessage('')
    try {
      const saved = await invoke<QuickActionSettings>('set_quick_action_settings', {
        settings: quickSettings,
        masterPassword,
      })
      setQuickSettings(saved)
      setQuickSaveMessage('快捷翻译设置已保存并重新注册热键')
    } catch (err) {
      console.error(err)
      setQuickSaveMessage(`保存失败: ${String(err)}`)
    } finally {
      setBusyKey(null)
    }
  }

  const saveVoiceInputSettings = async () => {
    if (!voiceSettings) return
    setBusyKey('voice-settings')
    setVoiceSaveMessage('')
    try {
      const saved = await invoke<VoiceInputSettings>('set_voice_input_settings', {
        settings: voiceSettings,
        masterPassword,
      })
      setVoiceSettings(saved)
      const diag = await invoke<VoiceInputDiagnostics>('get_voice_input_diagnostics', {
        masterPassword,
      })
      setVoiceDiagnostics(diag)
      const perm = await invoke<MacosPermissionStatus>('get_macos_permission_status')
      setMacPerm(perm)
      if (!saved.voice_input_enabled) {
        setVoiceSaveMessage('语音输入已关闭')
      } else if (diag.listener_running) {
        setVoiceSaveMessage('语音输入设置已保存并初始化监听')
      } else {
        setVoiceSaveMessage(`保存成功，但监听启动失败：${diag.last_error || '未知错误'}`)
      }
    } catch (err) {
      console.error(err)
      setVoiceSaveMessage(`保存失败: ${String(err)}`)
    } finally {
      setBusyKey(null)
    }
  }

  const runVoiceTriggerSelfTest = async () => {
    if (!masterPassword) return
    setVoiceSelfTestMessage('')
    setBusyKey('voice-self-test')
    try {
      const baseline = await invoke<VoiceInputDiagnostics>('get_voice_input_diagnostics', { masterPassword })
      setVoiceDiagnostics(baseline)
      const startCount = baseline.fn_edge_count || 0
      setVoiceSelfTestMessage('自检开始：请在 5 秒内按一下你选择的“触发键”（Fn 或 Option）')

      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 250))
        // eslint-disable-next-line no-await-in-loop
        const diag = await invoke<VoiceInputDiagnostics>('get_voice_input_diagnostics', { masterPassword })
        setVoiceDiagnostics(diag)
        const nowCount = diag.fn_edge_count || 0
        if (nowCount > startCount) {
          setVoiceSelfTestMessage('自检通过：已捕获到触发键事件')
          return
        }
      }

      setVoiceSelfTestMessage(
        '自检失败：5 秒内没有捕获到触发键事件。可能原因：1) 未开启“输入监控”权限；2) macOS 系统功能或其它软件抢占了该键。建议先开启“输入监控(MyKey)”，再切换触发键为“长按 Option（备用）”，或到键盘设置关闭 Fn 的系统动作。'
      )
    } catch (err) {
      console.error(err)
      setVoiceSelfTestMessage(`自检失败: ${String(err)}`)
    } finally {
      setBusyKey(null)
    }
  }

  const refreshDebugLogs = async () => {
    setBusyKey('debug-logs')
    try {
      const logs = await invoke<RecentDebugLogs>('get_recent_debug_logs', { limit: 240 })
      setDebugLogs(logs)
    } catch (err) {
      console.error(err)
      setDebugLogs({
        path: '',
        lines: [`加载日志失败: ${String(err)}`],
      })
    } finally {
      setBusyKey(null)
    }
  }

  if (loading) {
    return (
      <section className="panel settings-panel-empty">
        <p>加载全局设置中...</p>
      </section>
    )
  }

  if (!settings) {
    return (
      <section className="panel settings-panel-empty">
        <p>{error || '无法读取全局设置'}</p>
        <button className="btn btn-primary" onClick={() => refresh()}>
          重新加载
        </button>
      </section>
    )
  }

  return (
    <div className="settings-view">
      {error ? (
        <section className="panel settings-section">
          <div className="panel-header">
            <h2>加载提示</h2>
          </div>
          <div className="settings-item-subtitle">{error}</div>
        </section>
      ) : null}
      <section className="panel settings-summary-grid">
        <div className="settings-summary-card">
          <span className="settings-summary-label">启用集成</span>
          <span className="settings-summary-value">{activeIntegrations}</span>
          <span className="settings-summary-hint">共 {integrations.length} 个客户端</span>
        </div>
        <div className="settings-summary-card">
          <span className="settings-summary-label">启用服务</span>
          <span className="settings-summary-value">{activeServices}</span>
          <span className="settings-summary-hint">共 {services.length} 个后台服务</span>
        </div>
        <div className="settings-summary-card">
          <span className="settings-summary-label">日志级别</span>
          <span className="settings-summary-value">{settings.log_level.toUpperCase()}</span>
          <span className="settings-summary-hint">
            {settings.debug_mode ? 'Debug 模式已开启' : 'Debug 模式已关闭'}
          </span>
          <div style={{ marginTop: 10 }}>
            <button
              className={`btn ${settings.debug_mode ? 'btn-secondary' : 'btn-primary'}`}
              disabled={busyKey === 'debug-mode'}
              onClick={() => toggleDebug(!settings.debug_mode)}
            >
              {settings.debug_mode ? '关闭 Debug' : '开启 Debug'}
            </button>
          </div>
        </div>
      </section>

      <section className="panel settings-section">
        <div className="panel-header">
          <h2>Vault 解锁方式</h2>
        </div>
        <div className="settings-list">
          <div className="settings-item">
            <div className="settings-item-header">
              <div>
                <div className="settings-item-title">主密码 / Touch ID</div>
                <div className="settings-item-subtitle">
                  主密码和 Touch ID 解锁同一个本地 vault；Touch ID 使用受系统验证保护的本机 Keychain。
                </div>
              </div>
              <div className="settings-item-badges">
                <span className={`service-badge ${vaultUnlockState?.configured ? 'enabled' : 'disabled'}`}>
                  {vaultUnlockLabels?.configuredLabel || '加载中'}
                </span>
                <span className="service-badge running">
                  {authMethod === 'passkey-prf'
                    ? '当前 Passkey'
                    : authMethod === 'biometric-keychain'
                      ? '当前 Touch ID'
                      : '当前主密码'}
                </span>
                <span className={`service-badge ${biometricKeychainConfigured ? 'enabled' : 'disabled'}`}>
                  {biometricKeychainConfigured ? 'Touch ID 已启用' : 'Touch ID 未启用'}
                </span>
              </div>
            </div>
            <div className="settings-item-controls">
              {biometricKeychainConfigured ? (
                <button
                  className="btn btn-primary"
                  disabled={busyKey === 'biometric-keychain'}
                  onClick={removeBiometricKeychain}
                >
                  {busyKey === 'biometric-keychain' ? '处理中...' : '关闭 Touch ID 解锁'}
                </button>
              ) : (
                <button
                  className="btn btn-primary"
                  disabled={
                    !biometricKeychainAvailable ||
                    !canEnableBiometricKeychain(authMethod, vaultUnlockState, busyKey === 'biometric-keychain')
                  }
                  onClick={enableBiometricKeychain}
                >
                  {busyKey === 'biometric-keychain' ? '处理中...' : '启用 Touch ID 解锁'}
                </button>
              )}
              <button
                className="btn btn-secondary"
                disabled={!canRegisterVaultPasskey(authMethod, vaultUnlockState, busyKey === 'vault-passkey')}
                onClick={addVaultPasskey}
              >
                {busyKey === 'vault-passkey' ? '创建中...' : '添加 Passkey'}
              </button>
            </div>
            <div className="settings-item-subtitle">
              {vaultUnlockLabels
                ? `Touch ID ${biometricKeychainConfigured ? '已启用' : '未启用'}；${vaultUnlockLabels.passkeyLabel}；${vaultUnlockLabels.recoveryLabel}`
                : '正在读取解锁方式...'}
            </div>
            {!biometricKeychainAvailable ? (
              <div className="settings-item-subtitle">
                Touch ID 快速解锁仅支持 macOS。
              </div>
            ) : null}
            {authMethod === 'passkey-prf' ? (
              <div className="settings-item-subtitle">
                当前用 passkey 登录，可继续读写已加密数据；新增 passkey 需要主密码验证。
              </div>
            ) : null}
            {vaultUnlockMessage ? <div className="backup-message">{vaultUnlockMessage}</div> : null}
          </div>
        </div>
      </section>

      <section className="panel settings-section">
        <div className="panel-header">
          <h2>快捷翻译</h2>
        </div>
        {quickSettings ? (
          <div className="settings-list">
            <div className="settings-item">
              <div className="settings-item-header">
                <div>
                  <div className="settings-item-title">快捷翻译</div>
                  <div className="settings-item-subtitle">
                    推荐使用 Option+D（划词）与 Option+S（截图）。
                  </div>
                </div>
              </div>
              <div className="settings-item-controls">
                <div className="port-editor">
                  <input
                    value={quickSettings.translate_hotkey}
                    onChange={(event) =>
                      setQuickSettings((prev) =>
                        prev ? { ...prev, translate_hotkey: event.target.value } : prev
                      )
                    }
                    placeholder="Option+D"
                  />
                </div>
                <div className="port-editor">
                  <input
                    value={quickSettings.ocr_hotkey}
                    onChange={(event) =>
                      setQuickSettings((prev) =>
                        prev ? { ...prev, ocr_hotkey: event.target.value } : prev
                      )
                    }
                    placeholder="Option+S"
                  />
                </div>
              </div>
              <div className="settings-item-controls">
                <label className="shipkey-field">
                  <span>翻译 Provider</span>
                  <select
                    className="shipkey-target-select"
                    value={quickSettings.default_translate_provider}
                    onChange={(event) =>
                      setQuickSettings((prev) =>
                        prev
                          ? { ...prev, default_translate_provider: event.target.value }
                          : prev
                      )
                    }
                  >
                    {translateProviderOptions.map((provider) => (
                      <option key={provider.provider} value={provider.provider}>
                        {provider.label || provider.provider}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="shipkey-field">
                  <span>OCR Provider</span>
                  <select
                    className="shipkey-target-select"
                    value={quickSettings.default_ocr_provider}
                    onChange={(event) =>
                      setQuickSettings((prev) =>
                        prev ? { ...prev, default_ocr_provider: event.target.value } : prev
                      )
                    }
                  >
                    {ocrProviderOptions.map((provider) => (
                      <option key={provider.provider} value={provider.provider}>
                        {provider.label || provider.provider}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="settings-item-controls">
                <label className="shipkey-field">
                  <span>源语言</span>
                  <input
                    value={quickSettings.source_lang}
                    onChange={(event) =>
                      setQuickSettings((prev) =>
                        prev ? { ...prev, source_lang: event.target.value } : prev
                      )
                    }
                    placeholder="auto"
                  />
                </label>
                <label className="shipkey-field">
                  <span>目标语言</span>
                  <input
                    value={quickSettings.target_lang}
                    onChange={(event) =>
                      setQuickSettings((prev) =>
                        prev ? { ...prev, target_lang: event.target.value } : prev
                      )
                    }
                    placeholder="zh-Hans"
                  />
                </label>
                <label className="shipkey-field">
                  <span>自动关闭（秒）</span>
                  <input
                    type="number"
                    min={3}
                    max={120}
                    value={quickSettings.auto_close_seconds}
                    onChange={(event) => {
                      const value = Number.parseInt(event.target.value, 10)
                      setQuickSettings((prev) =>
                        prev
                          ? {
                              ...prev,
                              auto_close_seconds: Number.isNaN(value) ? 15 : value,
                            }
                          : prev
                      )
                    }}
                  />
                </label>
              </div>
              <div className="settings-item-controls">
                <button
                  className="btn btn-primary"
                  disabled={busyKey === 'quick-settings'}
                  onClick={saveQuickActionSettings}
                >
                  {busyKey === 'quick-settings' ? '保存中...' : '保存并注册热键'}
                </button>
              </div>
              {quickSaveMessage ? <div className="settings-item-subtitle">{quickSaveMessage}</div> : null}
            </div>
          </div>
        ) : (
          <div className="settings-item-subtitle">快捷翻译设置加载中...</div>
        )}
      </section>

      <section className="panel settings-section">
        <div className="panel-header">
          <h2>语音输入（长按 Fn）</h2>
        </div>
        {voiceSettings ? (
          <div className="settings-list">
            <div className="settings-item">
              <div className="settings-item-header">
                <div>
                  <div className="settings-item-title">Fn Hold 语音输入</div>
                  <div className="settings-item-subtitle">
                    将光标放到任意文本框中，长按 Fn 开始录音，松开 Fn 停止并自动转写粘贴。Esc 取消本次粘贴但仍会保存到历史记录；免提模式用 Fn+Space 开始/停止。需要麦克风/辅助功能/输入监控权限。
                  </div>
                </div>
                <div className="settings-item-badges">
                  <span
                    className={`service-badge ${voiceSettings.voice_input_enabled ? 'enabled' : 'disabled'}`}
                  >
                    {voiceSettings.voice_input_enabled ? '已启用' : '已禁用'}
                  </span>
                  {voiceDiagnostics ? (
                    <span className={`service-badge ${voiceDiagnostics.listener_running ? 'running' : 'stopped'}`}>
                      {voiceDiagnostics.listener_running ? '监听中' : '未监听'}
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="settings-item-controls">
                <button
                  className={`btn ${voiceSettings.voice_input_enabled ? 'btn-secondary' : 'btn-primary'}`}
                  disabled={busyKey === 'voice-settings'}
                  onClick={() =>
                    setVoiceSettings((prev) =>
                      prev ? { ...prev, voice_input_enabled: !prev.voice_input_enabled } : prev
                    )
                  }
                >
                  {voiceSettings.voice_input_enabled ? '关闭语音输入' : '启用语音输入'}
                </button>
              </div>

              <div className="settings-item-controls">
                <label className="shipkey-field">
                  <span>触发键</span>
                  <select
                    className="shipkey-target-select"
                    value={voiceSettings.voice_trigger_mode}
                    onChange={(event) =>
                      setVoiceSettings((prev) =>
                        prev ? { ...prev, voice_trigger_mode: event.target.value } : prev
                      )
                    }
                  >
                    <option value="fn_hold">长按 Fn（默认）</option>
                    <option value="option_hold">长按 Option（备用）</option>
                    <option value="fn_option_hold">长按 Fn+Option（组合）</option>
                  </select>
                </label>
                <label className="shipkey-field">
                  <span>长按阈值（ms）</span>
                  <input
                    type="number"
                    min={120}
                    max={800}
                    value={voiceSettings.voice_hold_ms}
                    onChange={(event) => {
                      const value = Number.parseInt(event.target.value, 10)
                      setVoiceSettings((prev) =>
                        prev ? { ...prev, voice_hold_ms: Number.isNaN(value) ? 200 : value } : prev
                      )
                    }}
                  />
                </label>
                <label className="shipkey-field">
                  <span>最短录音（ms）</span>
                  <input
                    type="number"
                    min={120}
                    max={8000}
                    value={voiceSettings.voice_min_record_ms}
                    onChange={(event) => {
                      const value = Number.parseInt(event.target.value, 10)
                      setVoiceSettings((prev) =>
                        prev
                          ? { ...prev, voice_min_record_ms: Number.isNaN(value) ? 300 : value }
                          : prev
                      )
                    }}
                  />
                </label>
              </div>

              <div className="settings-item-controls">
                <label className="shipkey-field">
                  <span>免提模式（Fn+Space）</span>
                  <select
                    className="shipkey-target-select"
                    value={voiceSettings.voice_hands_free_enabled ? 'true' : 'false'}
                    onChange={(event) =>
                      setVoiceSettings((prev) =>
                        prev
                          ? { ...prev, voice_hands_free_enabled: event.target.value === 'true' }
                          : prev
                      )
                    }
                  >
                    <option value="false">关闭</option>
                    <option value="true">开启</option>
                  </select>
                </label>
                <label className="shipkey-field">
                  <span>AI 自动编辑</span>
                  <select
                    className="shipkey-target-select"
                    value={voiceSettings.voice_ai_auto_edit ? 'true' : 'false'}
                    onChange={(event) =>
                      setVoiceSettings((prev) =>
                        prev ? { ...prev, voice_ai_auto_edit: event.target.value === 'true' } : prev
                      )
                    }
                  >
                    <option value="false">关闭</option>
                    <option value="true">开启（润色/去口癖/格式化）</option>
                  </select>
                </label>
                <label className="shipkey-field">
                  <span>AI 模型（可选）</span>
                  <input
                    value={voiceSettings.voice_ai_model}
                    disabled={!voiceSettings.voice_ai_auto_edit}
                    onChange={(event) =>
                      setVoiceSettings((prev) =>
                        prev ? { ...prev, voice_ai_model: event.target.value } : prev
                      )
                    }
                    placeholder="留空使用 codex 路由默认模型"
                  />
                </label>
              </div>

              <div className="settings-item-controls">
                <label className="shipkey-field">
                  <span>STT Provider</span>
                  <select
                    className="shipkey-target-select"
                    value={voiceSettings.voice_stt_provider}
                    onChange={(event) => {
                      const nextProvider = event.target.value
                      setVoiceSettings((prev) => {
                        if (!prev) return prev
                        let nextModel = prev.voice_stt_model
                        let nextLanguage = prev.voice_language
                        if (nextProvider === 'elevenlabs') {
                          const current = (nextModel || '').trim()
                          if (!current || current === 'whisper-1') {
                            nextModel = 'scribe_v2'
                          }
                          const lang = (nextLanguage || '').trim()
                          if (!lang || lang === 'auto') {
                            nextLanguage = 'zh'
                          }
                        }
                        return {
                          ...prev,
                          voice_stt_provider: nextProvider,
                          voice_stt_model: nextModel,
                          voice_language: nextLanguage,
                        }
                      })
                    }}
                  >
                    {sttProviderOptions.map((provider) => (
                      <option key={provider.provider} value={provider.provider}>
                        {provider.label || provider.provider}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="shipkey-field">
                  <span>模型</span>
                  <input
                    value={voiceSettings.voice_stt_model}
                    onChange={(event) =>
                      setVoiceSettings((prev) =>
                        prev ? { ...prev, voice_stt_model: event.target.value } : prev
                      )
                    }
                    placeholder="whisper-1"
                  />
                </label>
                <label className="shipkey-field">
                  <span>语言</span>
                  {(() => {
                    const current = (voiceSettings.voice_language || '').trim()
                    const isPreset = voiceLanguagePresets.some((item) => item.value === current)
                    const selectValue = isPreset ? current : '__custom__'
                    return (
                      <>
                        <select
                          className="shipkey-target-select"
                          value={selectValue}
                          onChange={(event) => {
                            const value = event.target.value
                            if (value === '__custom__') return
                            setVoiceSettings((prev) => (prev ? { ...prev, voice_language: value } : prev))
                          }}
                        >
                          {voiceLanguagePresets.map((item) => (
                            <option key={item.value} value={item.value}>
                              {item.label}
                            </option>
                          ))}
                          <option value="__custom__">自定义…</option>
                        </select>
                        {selectValue === '__custom__' ? (
                          <input
                            value={voiceSettings.voice_language}
                            onChange={(event) =>
                              setVoiceSettings((prev) =>
                                prev ? { ...prev, voice_language: event.target.value } : prev
                              )
                            }
                            placeholder="ISO-639-1/3 (例如 zh / cmn / en)"
                          />
                        ) : null}
                      </>
                    )
                  })()}
                </label>
              </div>

              <div className="settings-item-controls">
                <label className="shipkey-field">
                  <span>自动粘贴</span>
                  <select
                    className="shipkey-target-select"
                    value={voiceSettings.voice_auto_paste ? 'true' : 'false'}
                    onChange={(event) =>
                      setVoiceSettings((prev) =>
                        prev
                          ? { ...prev, voice_auto_paste: event.target.value === 'true' }
                          : prev
                      )
                    }
                  >
                    <option value="true">是</option>
                    <option value="false">否（仅写入剪贴板）</option>
                  </select>
                </label>
                <label className="shipkey-field">
                  <span>粘贴延迟（ms）</span>
                  <input
                    type="number"
                    min={0}
                    max={1200}
                    value={voiceSettings.voice_paste_delay_ms}
                    onChange={(event) => {
                      const value = Number.parseInt(event.target.value, 10)
                      setVoiceSettings((prev) =>
                        prev ? { ...prev, voice_paste_delay_ms: Number.isNaN(value) ? 120 : value } : prev
                      )
                    }}
                  />
                </label>
                <label className="shipkey-field">
                  <span>恢复剪贴板</span>
                  <select
                    className="shipkey-target-select"
                    value={voiceSettings.voice_restore_clipboard ? 'true' : 'false'}
                    onChange={(event) =>
                      setVoiceSettings((prev) =>
                        prev
                          ? { ...prev, voice_restore_clipboard: event.target.value === 'true' }
                          : prev
                      )
                    }
                  >
                    <option value="false">否（保留本次转写文本）</option>
                    <option value="true">是（仅文本，可能影响图片/文件剪贴板）</option>
                  </select>
                </label>
                <label className="shipkey-field">
                  <span>末尾加空格</span>
                  <select
                    className="shipkey-target-select"
                    value={voiceSettings.voice_append_trailing_space ? 'true' : 'false'}
                    onChange={(event) =>
                      setVoiceSettings((prev) =>
                        prev
                          ? { ...prev, voice_append_trailing_space: event.target.value === 'true' }
                          : prev
                      )
                    }
                  >
                    <option value="true">是</option>
                    <option value="false">否</option>
                  </select>
                </label>
              </div>

              <div className="settings-item-controls">
                <button
                  className="btn btn-primary"
                  disabled={busyKey === 'voice-settings'}
                  onClick={saveVoiceInputSettings}
                >
                  {busyKey === 'voice-settings' ? '保存中...' : '保存'}
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={busyKey === 'voice-self-test'}
                  onClick={runVoiceTriggerSelfTest}
                >
                  {busyKey === 'voice-self-test' ? '自检中...' : '自检触发键'}
                </button>
              </div>

              {voiceSaveMessage ? <div className="settings-item-subtitle">{voiceSaveMessage}</div> : null}
              {voiceSelfTestMessage ? <div className="settings-item-subtitle">{voiceSelfTestMessage}</div> : null}
              {voiceDiagnostics?.last_error ? (
                <div className="settings-item-subtitle">最近错误: {voiceDiagnostics.last_error}</div>
              ) : null}
              {voiceDiagnostics ? (
                <div className="settings-item-subtitle">
                  触发键边沿次数: {voiceDiagnostics.fn_edge_count ?? 0}
                  {voiceDiagnostics.last_fn_edge_at ? `（最近: ${voiceDiagnostics.last_fn_edge_at}）` : ''}
                </div>
              ) : null}
              {voiceDiagnostics ? (
                <div className="settings-item-subtitle">
                  原始键盘事件: {voiceDiagnostics.raw_event_count ?? 0}
                  {voiceDiagnostics.last_raw_event_type ? `（最近: ${voiceDiagnostics.last_raw_event_type}` : ''}
                  {voiceDiagnostics.last_raw_keycode != null ? ` keycode=${voiceDiagnostics.last_raw_keycode}` : ''}
                  {voiceDiagnostics.last_raw_event_at ? ` @ ${voiceDiagnostics.last_raw_event_at}` : ''}
                  {voiceDiagnostics.last_raw_event_type ? ')' : ''}
                </div>
              ) : null}
              {voiceDiagnostics?.tap_location ? (
                <div className="settings-item-subtitle">EventTap: {voiceDiagnostics.tap_location}</div>
              ) : null}
              {voiceSettings.voice_input_enabled && voiceDiagnostics?.listener_running && (voiceDiagnostics?.fn_edge_count ?? 0) <= 0 ? (
                <div className="settings-item-subtitle">
                  提示: 触发键无响应时，先按一下你选择的触发键，看“边沿次数”是否增加；若不增加，说明系统/其他软件抢占了该键。
                  可切换到“长按 Option（备用）”，或在 macOS 键盘设置里把 Fn 的系统动作关闭。
                </div>
              ) : null}
              {voiceSettings.voice_input_enabled &&
              voiceDiagnostics?.listener_running &&
              (voiceDiagnostics?.raw_event_count ?? 0) > 0 &&
              (voiceDiagnostics?.fn_edge_count ?? 0) <= 0 ? (
                <div className="settings-item-subtitle">
                  诊断: 已收到键盘事件但没有捕获到“触发键”边沿。若你按的是 Fn，通常表示 Fn 被系统占用或不会被 macOS 作为可监听事件发出；
                  建议把触发键切到“长按 Option（备用）”，或在键盘设置里关闭 Fn 的系统动作后再试。
                </div>
              ) : null}
              {macPerm?.is_macos ? (
                <div className="settings-item-subtitle">
                  权限状态: 辅助功能 {macPerm.accessibility_granted ? '已授权' : '未授权'}；输入监控{' '}
                  {macPerm.input_monitoring_granted ? '已授权' : '未授权'}
                </div>
              ) : null}
              {macPerm?.is_macos && (macPerm.process_name || macPerm.executable_path) ? (
                <div className="settings-item-subtitle">
                  当前运行进程: {macPerm.process_name || '未知'}
                  {macPerm.executable_path ? `（${macPerm.executable_path}）` : ''}
                </div>
              ) : null}
              {macPerm?.is_macos && !macPerm.accessibility_granted ? (
                <div className="settings-item-controls">
                  <button
                    className="btn btn-secondary"
                    onClick={() => invoke('open_macos_accessibility_settings')}
                  >
                    打开辅助功能设置
                  </button>
                </div>
              ) : null}
              {macPerm?.is_macos && !macPerm.input_monitoring_granted ? (
                <div className="settings-item-controls">
                  <button
                    className="btn btn-secondary"
                    onClick={() => invoke('open_macos_input_monitoring_settings')}
                  >
                    打开输入监控设置
                  </button>
                </div>
              ) : null}
              {macPerm?.is_macos ? (
                <div className="settings-item-controls">
                  <button
                    className="btn btn-secondary"
                    onClick={() => invoke('open_macos_keyboard_settings')}
                  >
                    打开键盘设置
                  </button>
                </div>
              ) : null}
              {voiceDiagnostics?.last_latency_ms ? (
                <div className="settings-item-subtitle">最近转写耗时: {voiceDiagnostics.last_latency_ms}ms</div>
              ) : null}

              <div className="settings-item-controls">
                <button className="btn btn-secondary" disabled={busyKey === 'debug-logs'} onClick={refreshDebugLogs}>
                  {busyKey === 'debug-logs' ? '加载中...' : '查看 Debug Log'}
                </button>
              </div>
              {debugLogs ? (
                <div className="settings-item-subtitle">
                  日志文件: {debugLogs.path || '（未知）'}
                  <pre style={{ whiteSpace: 'pre-wrap', marginTop: 8, maxHeight: 220, overflow: 'auto' }}>
                    {debugLogs.lines.join('\n') || '（空）'}
                  </pre>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="settings-item-subtitle">语音输入设置加载中...</div>
        )}
      </section>

      <section className="panel settings-section">
        <div className="panel-header">
          <h2>服务</h2>
          <span className="panel-count">{services.length}</span>
        </div>
        <div className="settings-list">
          {services.map((service) => (
            <div key={service.service_name} className="settings-item">
              <div className="settings-item-header">
                <div>
                  <div className="settings-item-title">
                    {serviceLabels[service.service_name] || service.service_name}
                  </div>
                  <div className="settings-item-subtitle">
                    {serviceDescriptions[service.service_name] || '后台服务'}
                  </div>
                </div>
                <div className="settings-item-badges">
                  <span className={`service-badge ${service.enabled ? 'enabled' : 'disabled'}`}>
                    {service.enabled ? '已启用' : '已禁用'}
                  </span>
                  <span className={`service-badge ${service.running ? 'running' : 'stopped'}`}>
                    {service.running ? '运行中' : '未运行'}
                  </span>
                </div>
              </div>
              <div className="settings-item-controls">
                <button
                  className={`btn ${service.enabled ? 'btn-secondary' : 'btn-primary'}`}
                  disabled={busyKey === `service-enabled:${service.service_name}`}
                  onClick={() => updateServiceEnabled(service.service_name, !service.enabled)}
                >
                  {service.enabled ? '禁用' : '启用'}
                </button>
                <button
                  className={`btn ${service.auto_start ? 'btn-secondary' : 'btn-primary'}`}
                  disabled={busyKey === `service-auto:${service.service_name}`}
                  onClick={() =>
                    updateServiceAutoStart(service.service_name, !service.auto_start)
                  }
                >
                  {service.auto_start ? '取消自动启动' : '自动启动'}
                </button>
                <div className="port-editor">
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={portDrafts[service.service_name] ?? ''}
                    onChange={(event) =>
                      setPortDrafts((prev) => ({
                        ...prev,
                        [service.service_name]: event.target.value,
                      }))
                    }
                    placeholder="端口"
                  />
                  <button
                    className="btn btn-secondary"
                    disabled={busyKey === `service-port:${service.service_name}`}
                    onClick={() => saveServicePort(service)}
                  >
                    保存端口
                  </button>
                </div>
              </div>
              {service.service_name === 'gateway' ? (
                <div className="gateway-helper">
                  <div className="gateway-helper-title">OpenAI 兼容入口</div>
                  <div className="gateway-helper-lines">
                    <code>Base URL: {gatewayBaseUrl}</code>
                    <code>Responses: {gatewayBaseUrl}/v1/responses</code>
                    <code>Health: {gatewayBaseUrl}/health</code>
                  </div>
                  <div className="gateway-helper-note">
                    网关读取 <code>~/.codex/auth.json</code> 的 <code>tokens.access_token</code> 与
                    <code>tokens.account_id</code>。如需覆盖，可设置环境变量
                    <code>MYKEY_CODEX_ACCESS_TOKEN</code> 和 <code>MYKEY_CODEX_ACCOUNT_ID</code>。
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <section className="panel settings-section">
        <div className="panel-header">
          <h2>客户端集成</h2>
          <span className="panel-count">{integrations.length}</span>
        </div>
        <div className="settings-list">
          {integrations.map((integration) => (
            <div key={integration.id} className="settings-item">
              <div className="settings-item-header">
                <div>
                  <div className="settings-item-title">
                    {integrationLabels[integration.app_type] || integration.app_type}
                  </div>
                  <div className="settings-item-subtitle">
                    {integration.config_path || '无默认配置路径'}
                  </div>
                </div>
                <div className="settings-item-badges">
                  <span className={`service-badge ${integration.detected ? 'running' : 'stopped'}`}>
                    {integration.detected ? '已检测' : '未检测'}
                  </span>
                  <span className={`service-badge ${integration.enabled ? 'enabled' : 'disabled'}`}>
                    {integration.enabled ? '已启用' : '未启用'}
                  </span>
                </div>
              </div>
              <div className="settings-item-controls">
                <button
                  className={`btn ${integration.enabled ? 'btn-secondary' : 'btn-primary'}`}
                  disabled={busyKey === `integration:${integration.app_type}`}
                  onClick={() =>
                    updateIntegration(integration.app_type, !integration.enabled)
                  }
                >
                  {integration.enabled ? '停用集成' : '启用集成'}
                </button>
                {integration.detected && integration.config_path && (
                  <button
                    className="btn btn-secondary"
                    disabled={busyKey === `open:${integration.config_path}`}
                    onClick={() => openPath(integration.config_path as string)}
                  >
                    打开路径
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel settings-section">
        <div className="panel-header">
          <h2>诊断与备份</h2>
        </div>
        <div className="settings-list">
          <div className="settings-item">
            <div className="settings-item-header">
              <div>
                <div className="settings-item-title">网关风控</div>
                <div className="settings-item-subtitle">
                  管理全局熔断与每日预算，并查看最近请求流水。
                </div>
              </div>
              <div className="settings-item-badges">
                <span
                  className={`service-badge ${
                    gatewayPolicy?.circuit_breaker_enabled ? 'stopped' : 'enabled'
                  }`}
                >
                  {gatewayPolicy?.circuit_breaker_enabled ? '熔断已开启' : '熔断关闭'}
                </span>
              </div>
            </div>
            <div className="settings-item-controls">
              <button
                className={`btn ${
                  gatewayPolicy?.circuit_breaker_enabled ? 'btn-primary' : 'btn-secondary'
                }`}
                disabled={busyKey === 'gateway-circuit-breaker'}
                onClick={() => toggleCircuitBreaker(!gatewayPolicy?.circuit_breaker_enabled)}
              >
                {gatewayPolicy?.circuit_breaker_enabled ? '恢复网关' : '紧急停止'}
              </button>
              <div className="port-editor">
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={budgetDraft}
                  onChange={(event) => setBudgetDraft(event.target.value)}
                  placeholder="每日预算 USD"
                />
                <button
                  className="btn btn-secondary"
                  disabled={busyKey === 'gateway-daily-budget'}
                  onClick={saveDailyBudget}
                >
                  保存预算
                </button>
              </div>
            </div>
            <div className="settings-item-subtitle">
              今日请求 {gatewayPolicy?.today_request_count ?? 0} 次，累计成本 $
              {(gatewayPolicy?.today_cost_usd ?? 0).toFixed(4)}
              {gatewayPolicy?.daily_budget_usd
                ? ` / 预算 $${gatewayPolicy.daily_budget_usd.toFixed(2)}`
                : ' / 未设置预算'}
            </div>
            <div className="gateway-traffic-controls">
              <label className="shipkey-field">
                <span>监控窗口</span>
                <select
                  className="shipkey-target-select"
                  value={gatewayTrafficWindow}
                  onChange={(event) => setGatewayTrafficWindow(Number(event.target.value))}
                >
                  {GATEWAY_TRAFFIC_WINDOWS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="btn btn-secondary"
                disabled={busyKey === 'gateway-traffic-refresh'}
                onClick={refreshGatewayTraffic}
              >
                刷新监控
              </button>
            </div>
            {gatewayTraffic ? (
              <>
                <div className="gateway-traffic-kpi-grid">
                  <div className="gateway-traffic-kpi-card">
                    <span>总请求</span>
                    <strong>{gatewayTraffic.total_requests}</strong>
                    <small>{gatewayTraffic.requests_per_minute.toFixed(2)} req/min</small>
                  </div>
                  <div className="gateway-traffic-kpi-card">
                    <span>成功率</span>
                    <strong>{gatewaySuccessRate.toFixed(1)}%</strong>
                    <small>错误率 {gatewayErrorRate.toFixed(1)}%</small>
                  </div>
                  <div className="gateway-traffic-kpi-card">
                    <span>平均耗时</span>
                    <strong>
                      {gatewayTraffic.avg_latency_ms ? `${Math.round(gatewayTraffic.avg_latency_ms)}ms` : '--'}
                    </strong>
                    <small>P95 {gatewayTraffic.p95_latency_ms ? `${gatewayTraffic.p95_latency_ms}ms` : '--'}</small>
                  </div>
                  <div className="gateway-traffic-kpi-card">
                    <span>拦截与成本</span>
                    <strong>{gatewayTraffic.blocked_requests}</strong>
                    <small>${gatewayTraffic.estimated_cost_usd.toFixed(4)}</small>
                  </div>
                </div>

                <div className="gateway-traffic-breakdown-grid">
                  <div className="gateway-traffic-card">
                    <h4>按应用</h4>
                    <table className="gateway-traffic-table">
                      <thead>
                        <tr>
                          <th>应用</th>
                          <th>请求</th>
                          <th>成功</th>
                          <th>P95</th>
                        </tr>
                      </thead>
                      <tbody>
                        {gatewayTraffic.by_app.slice(0, 6).map((item) => (
                          <tr key={`app-${item.key}`}>
                            <td>{integrationLabels[item.key] || item.key}</td>
                            <td>{item.requests}</td>
                            <td>{item.success_requests}</td>
                            <td>{item.p95_latency_ms ? `${item.p95_latency_ms}ms` : '--'}</td>
                          </tr>
                        ))}
                        {gatewayTraffic.by_app.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="gateway-log-empty">
                              暂无应用流量
                            </td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>

                  <div className="gateway-traffic-card">
                    <h4>按提供商</h4>
                    <table className="gateway-traffic-table">
                      <thead>
                        <tr>
                          <th>提供商</th>
                          <th>请求</th>
                          <th>错误</th>
                          <th>P95</th>
                        </tr>
                      </thead>
                      <tbody>
                        {gatewayTraffic.by_provider.slice(0, 6).map((item) => (
                          <tr key={`provider-${item.key}`}>
                            <td>{item.key}</td>
                            <td>{item.requests}</td>
                            <td>{item.error_requests}</td>
                            <td>{item.p95_latency_ms ? `${item.p95_latency_ms}ms` : '--'}</td>
                          </tr>
                        ))}
                        {gatewayTraffic.by_provider.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="gateway-log-empty">
                              暂无提供商流量
                            </td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>

                  <div className="gateway-traffic-card">
                    <h4>错误 Top</h4>
                    <table className="gateway-traffic-table">
                      <thead>
                        <tr>
                          <th>错误码</th>
                          <th>次数</th>
                        </tr>
                      </thead>
                      <tbody>
                        {gatewayTraffic.top_errors.map((item) => (
                          <tr key={`err-${item.code}`}>
                            <td>{item.code}</td>
                            <td>{item.requests}</td>
                          </tr>
                        ))}
                        {gatewayTraffic.top_errors.length === 0 ? (
                          <tr>
                            <td colSpan={2} className="gateway-log-empty">
                              暂无错误
                            </td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>

                  <div className="gateway-traffic-card">
                    <h4>分钟趋势</h4>
                    <div className="gateway-timeline-mini">
                      {gatewayTraffic.timeline.slice(-12).map((point) => (
                        <div key={point.minute} className="gateway-timeline-row">
                          <span>{point.minute.slice(11)}</span>
                          <span>{point.requests} req</span>
                          <span>{point.error_requests} err</span>
                          <span>
                            {point.avg_latency_ms ? `${Math.round(point.avg_latency_ms)}ms` : '--'}
                          </span>
                        </div>
                      ))}
                      {gatewayTraffic.timeline.length === 0 ? (
                        <div className="gateway-log-empty">暂无时间线数据</div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </>
            ) : null}
            <div className="gateway-log-table-wrap">
              <table className="gateway-log-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>应用</th>
                    <th>端点</th>
                    <th>状态</th>
                    <th>耗时</th>
                    <th>原因</th>
                  </tr>
                </thead>
                <tbody>
                  {gatewayLogs.slice(0, 20).map((item) => (
                    <tr key={item.id}>
                      <td>{new Date(item.created_at).toLocaleTimeString()}</td>
                      <td>{integrationLabels[item.app_type] || item.app_type}</td>
                      <td>
                        <code>{item.endpoint}</code>
                      </td>
                      <td>{item.status_code}</td>
                      <td>{item.latency_ms}ms</td>
                      <td>{item.blocked_reason || item.error_code || '-'}</td>
                    </tr>
                  ))}
                  {gatewayLogs.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="gateway-log-empty">
                        暂无网关请求记录
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          <div className="settings-item">
            <div className="settings-item-header">
              <div>
                <div className="settings-item-title">Debug 模式</div>
                <div className="settings-item-subtitle">
                  开启后记录更详细日志，便于排查问题。
                </div>
              </div>
              <span className={`service-badge ${settings.debug_mode ? 'enabled' : 'disabled'}`}>
                {settings.debug_mode ? '已开启' : '已关闭'}
              </span>
            </div>
            <div className="settings-item-controls">
              <button
                className={`btn ${settings.debug_mode ? 'btn-secondary' : 'btn-primary'}`}
                disabled={busyKey === 'debug-mode'}
                onClick={() => toggleDebug(!settings.debug_mode)}
              >
                {settings.debug_mode ? '关闭 Debug' : '开启 Debug'}
              </button>
            </div>
          </div>

          <div className="settings-item">
            <div className="settings-item-header">
              <div>
                <div className="settings-item-title">配置路径</div>
                <div className="settings-item-subtitle">查看数据库和日志目录</div>
              </div>
            </div>
            <div className="path-list">
              <div className="path-row">
                <code>{settings.database_path}</code>
                <button
                  className="btn btn-secondary"
                  disabled={busyKey === `open:${settings.database_path}`}
                  onClick={() => openPath(settings.database_path)}
                >
                  打开
                </button>
              </div>
              <div className="path-row">
                <code>{settings.logs_path}</code>
                <button
                  className="btn btn-secondary"
                  disabled={busyKey === `open:${settings.logs_path}`}
                  onClick={() => openPath(settings.logs_path)}
                >
                  打开
                </button>
              </div>
            </div>
          </div>

          <div className="settings-item">
            <div className="settings-item-header">
              <div>
                <div className="settings-item-title">本地备份</div>
                <div className="settings-item-subtitle">
                  {settings.last_backup_at
                    ? `上次备份: ${new Date(settings.last_backup_at).toLocaleString()}`
                    : '尚未创建过备份'}
                </div>
              </div>
            </div>
            <div className="settings-item-controls">
              <button
                className="btn btn-primary"
                disabled={busyKey === 'backup-now'}
                onClick={createBackup}
              >
                立即备份
              </button>
              <button
                className="btn btn-secondary"
                disabled={busyKey === 'backup-restore'}
                onClick={restoreBackup}
              >
                恢复备份
              </button>
              <button
                className="btn btn-secondary"
                disabled={busyKey === 'backup-delete'}
                onClick={deleteBackup}
              >
                删除备份
              </button>
            </div>
            {backupMessage && <div className="backup-message">{backupMessage}</div>}
            {restoreMessage && <div className="backup-message">{restoreMessage}</div>}
            {deleteBackupMessage && <div className="backup-message">{deleteBackupMessage}</div>}
          </div>

          <div className="settings-item">
            <div className="settings-item-header">
                <div>
                  <div className="settings-item-title">已扫描项目 -&gt; 1Password 备份/恢复</div>
                <div className="settings-item-subtitle">
                  使用已扫描项目列表，不需要手填项目目录。支持一键备份到 1Password，以及从 1Password 恢复到项目 env 文件。
                </div>
              </div>
            </div>

            <div className="settings-item-controls">
              <button
                className="btn btn-danger"
                disabled={busyKey === 'project-clear'}
                onClick={clearProjectData}
              >
                {busyKey === 'project-clear' ? '清空中...' : '一键清空项目数据'}
              </button>
            </div>
            {clearProjectMessage ? <div className="backup-message">{clearProjectMessage}</div> : null}

            <div className="shipkey-grid">
              <label className="shipkey-field">
                <span>1Password Vault</span>
                <input value={projectSyncVault} onChange={(event) => setProjectSyncVault(event.target.value)} />
              </label>
              <label className="shipkey-field">
                <span>环境标识（section 后缀）</span>
                <input value={projectSyncEnv} onChange={(event) => setProjectSyncEnv(event.target.value)} />
              </label>
            </div>
            <div className="settings-item-subtitle">
              当前已扫描项目: {scannedProjects.length} 个
              {scannedProjects.length > 0 ? `（示例：${scannedProjects.slice(0, 3).map((p) => p.name).join('、')}）` : ''}
            </div>

            <div className="settings-item-controls">
              <button
                className={`btn btn-secondary ${shipkeyScanPreviewBusy ? 'shipkey-btn-loading' : ''}`}
                disabled={shipkeyBusy}
                onClick={backupProjectsToOnePassword}
                aria-busy={shipkeyScanPreviewBusy}
              >
                {shipkeyScanPreviewBusy ? (
                  <>
                    <span className="shipkey-spinner" />
                    备份中...
                  </>
                ) : (
                  '备份到 1Password'
                )}
              </button>
              <button
                className={`btn btn-primary ${shipkeyScanWriteBusy ? 'shipkey-btn-loading' : ''}`}
                disabled={shipkeyBusy}
                onClick={restoreProjectsFromOnePassword}
                aria-busy={shipkeyScanWriteBusy}
              >
                {shipkeyScanWriteBusy ? (
                  <>
                    <span className="shipkey-spinner" />
                    恢复中...
                  </>
                ) : (
                  '从 1Password 恢复'
                )}
              </button>
            </div>

            {shipkeyBusy && shipkeyBusyLabel && (
              <div className="shipkey-running-status">
                <span className="shipkey-spinner" />
                <span>{shipkeyBusyLabel}</span>
              </div>
            )}
            {projectSyncNotice && (
              <div className={`project-sync-message ${projectSyncNotice.level}`}>{projectSyncNotice.text}</div>
            )}

            {projectSyncResult && (
              <div className="shipkey-result">
                <div className="shipkey-result-meta">
                  <span className={`service-badge ${projectSyncResult.failed_keys > 0 ? 'stopped' : 'enabled'}`}>
                    {projectSyncResult.failed_keys > 0 ? '部分失败' : '执行完成'}
                  </span>
                  <code>{`vault=${projectSyncResult.vault}, env=${projectSyncResult.env}`}</code>
                </div>
                <pre>{`项目总数: ${projectSyncResult.total_projects}
处理项目: ${projectSyncResult.processed_projects}
跳过项目: ${projectSyncResult.skipped_projects}
检测密钥: ${projectSyncResult.total_keys}
成功: ${projectSyncResult.success_keys}
失败: ${projectSyncResult.failed_keys}`}</pre>
                {projectSyncResult.results.length > 0 ? (
                  <pre className={projectSyncResult.failed_keys > 0 ? 'error' : ''}>
                    {projectSyncResult.results
                      .map((item) => {
                        const suffix = item.message ? ` (${item.message})` : ''
                        const restored = item.restored_file ? ` -> ${item.restored_file}` : ''
                        return `${item.project_name}: detected=${item.detected_keys}, ok=${item.success_keys}, fail=${item.failed_keys}${restored}${suffix}`
                      })
                      .join('\n')}
                  </pre>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
