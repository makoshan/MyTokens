import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './GlobalSettings.css'
import { GlobalSettingsPayload, ServiceConfig } from '../types/settings'

interface GlobalSettingsProps {
  masterPassword: string
}

const integrationLabels: Record<string, string> = {
  claude: 'Claude Code',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
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

export default function GlobalSettings({ masterPassword }: GlobalSettingsProps) {
  const [settings, setSettings] = useState<GlobalSettingsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [backupMessage, setBackupMessage] = useState<string>('')
  const [portDrafts, setPortDrafts] = useState<Record<string, string>>({})

  const services = settings?.services ?? []
  const integrations = settings?.integrations ?? []

  const refresh = async (showLoading = true) => {
    if (!masterPassword) return
    try {
      if (showLoading) {
        setLoading(true)
      }
      const payload = await invoke<GlobalSettingsPayload>('get_global_settings', {
        masterPassword,
      })
      setSettings(payload)
      setError(null)
    } catch (err) {
      console.error('Failed to load global settings:', err)
      setError('无法加载全局设置')
    } finally {
      if (showLoading) {
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    refresh()
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

  const createBackup = async () => {
    setBusyKey('backup-now')
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

  if (loading) {
    return (
      <section className="panel settings-panel-empty">
        <p>加载全局设置中...</p>
      </section>
    )
  }

  if (error || !settings) {
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
        </div>
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
            </div>
            {backupMessage && <div className="backup-message">{backupMessage}</div>}
          </div>
        </div>
      </section>
    </div>
  )
}
