import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ProviderUsageStatus } from '../types/usage';
import UsageCard from './UsageCard';
import './UsageDashboard.css';
import type { ProviderLinkageContext } from '../utils/linkage';
import { GatewayRequestLog, GatewayTrafficMetrics } from '../types/settings';

interface UsageDashboardProps {
  masterPassword: string
  providerContextById?: Record<string, ProviderLinkageContext>
  quickStats?: Array<{
    key: string
    label: string
    value: number
    view: 'keys' | 'projects' | 'mcp' | 'skills' | 'apps'
  }>
  onNavigate?: (view: 'providers' | 'keys' | 'projects' | 'mcp' | 'skills' | 'apps') => void
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

const GATEWAY_WINDOWS = [
  { label: '15 分钟', value: 15 },
  { label: '1 小时', value: 60 },
  { label: '6 小时', value: 360 },
  { label: '24 小时', value: 1440 },
]

interface GatewayOverviewProps {
  masterPassword: string
  onError: (msg: string) => void
}

function GatewayAnalyticsSection({ masterPassword, onError }: GatewayOverviewProps) {
  const [gatewayTraffic, setGatewayTraffic] = useState<GatewayTrafficMetrics | null>(null)
  const [gatewayLogs, setGatewayLogs] = useState<GatewayRequestLog[]>([])
  const [gatewayLoading, setGatewayLoading] = useState(false)
  const [gatewayWindow, setGatewayWindow] = useState<number>(60)
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  const [selectedUser, setSelectedUser] = useState<string | null>(null)

  const fetchData = async () => {
    if (!masterPassword) return
    try {
      setGatewayLoading(true)
      const [traffic, logs] = await Promise.all([
        invoke<GatewayTrafficMetrics>('get_gateway_traffic_metrics', {
          windowMinutes: gatewayWindow,
          masterPassword,
        }),
        invoke<GatewayRequestLog[]>('get_gateway_request_logs', {
          limit: 180,
          masterPassword,
        }),
      ])
      setGatewayTraffic(traffic)
      setGatewayLogs(logs)
      onError('')
      if (selectedModel && !traffic.by_model.some((item) => item.key === selectedModel)) {
        setSelectedModel(null)
      }
      if (selectedProvider && !traffic.by_provider.some((item) => item.key === selectedProvider)) {
        setSelectedProvider(null)
      }
      if (selectedUser && !traffic.by_user.some((item) => item.key === selectedUser)) {
        setSelectedUser(null)
      }
    } catch (error) {
      console.error('Failed to load gateway analytics:', error)
      onError('网关分析加载失败')
      setGatewayTraffic(null)
      setGatewayLogs([])
    } finally {
      setGatewayLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [masterPassword, gatewayWindow])

  const selectedModelLower = selectedModel?.trim().toLowerCase()
  const selectedProviderLower = selectedProvider?.trim().toLowerCase()
  const selectedUserLower = selectedUser?.trim().toLowerCase()

  const filteredLogs = gatewayLogs.filter((item) => {
    if (selectedModelLower && (item.model || '').trim().toLowerCase() !== selectedModelLower) {
      return false
    }
    if (selectedProviderLower && item.provider.toLowerCase() !== selectedProviderLower) {
      return false
    }
    if (selectedUserLower && (item.user_key || '').trim().toLowerCase() !== selectedUserLower) {
      return false
    }
    return true
  })

  const successRate = gatewayTraffic
    ? (gatewayTraffic.success_requests / Math.max(1, gatewayTraffic.total_requests)) * 100
    : 0
  const errorRate = gatewayTraffic
    ? ((gatewayTraffic.client_error_requests + gatewayTraffic.server_error_requests) /
      Math.max(1, gatewayTraffic.total_requests)) *
      100
    : 0
  const formatCost = (value: number | undefined) =>
    typeof value === 'number' ? `$${value.toFixed(4)}` : '--'
  const formatTokens = (value: number | undefined | null) =>
    typeof value === 'number' ? value.toLocaleString() : '--'
  const formatErrorRatio = (value: number, total: number) => {
    return `${((value / Math.max(1, total)) * 100).toFixed(1)}%`
  }

  return (
    <section className="usage-gateway-analytics panel">
      <div className="usage-section-header">
        <div className="usage-section-copy">
          <h2>Gateway 分析面板</h2>
          <p>按窗口聚合应用 / 模型流量、趋势与异常 Top，支持按模型筛选明细。</p>
        </div>
        <div className="usage-gateway-controls">
          <label className="usage-inline-field">
            <span>监控窗口</span>
            <select
              value={gatewayWindow}
              onChange={(event) => setGatewayWindow(Number(event.target.value))}
            >
              {GATEWAY_WINDOWS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={`usage-refresh-btn ${gatewayLoading ? 'is-loading' : ''}`}
            onClick={fetchData}
            disabled={gatewayLoading}
          >
            <span className="usage-symbol usage-refresh-icon" aria-hidden>↻</span>
            刷新网关分析
          </button>
        </div>
      </div>

      {!gatewayTraffic ? (
        <div className="usage-gateway-empty">
          <p>还没有网关流量数据，先调用一次网关接口后会自动出现。</p>
        </div>
      ) : (
        <>
          <div className="usage-kpi-row usage-kpi-row-sm">
            <article className="usage-kpi-card">
              <p>总请求</p>
              <strong>{gatewayTraffic.total_requests}</strong>
              <small>{gatewayTraffic.requests_per_minute.toFixed(2)} req/min</small>
            </article>
            <article className="usage-kpi-card">
              <p>成功率 / 错误率</p>
              <strong>{successRate.toFixed(1)}%</strong>
              <small>错误 {errorRate.toFixed(1)}%</small>
            </article>
            <article className="usage-kpi-card">
              <p>平均耗时 / P95</p>
              <strong>
                {gatewayTraffic.avg_latency_ms ? `${Math.round(gatewayTraffic.avg_latency_ms)}ms` : '--'}
              </strong>
              <small>{gatewayTraffic.p95_latency_ms ? `${gatewayTraffic.p95_latency_ms}ms` : '--'}</small>
            </article>
            <article className="usage-kpi-card">
              <p>拦截 / 成本</p>
              <strong>{gatewayTraffic.blocked_requests}</strong>
              <small>${gatewayTraffic.estimated_cost_usd.toFixed(4)}</small>
            </article>
            <article className="usage-kpi-card">
              <p>Token 消耗</p>
              <strong>{formatTokens(gatewayTraffic.total_tokens)}</strong>
              <small>
                in {formatTokens(gatewayTraffic.total_input_tokens)} / out {formatTokens(gatewayTraffic.total_output_tokens)}
              </small>
            </article>
          </div>

          <div className="usage-gateway-grid">
            <div className="usage-mini-panel">
              <div className="usage-mini-panel-header">
                <h3>按模型排行</h3>
                {selectedModel ? <span>当前: {selectedModel}</span> : null}
                {selectedModel ? (
                  <button
                    type="button"
                    className="usage-text-btn"
                    onClick={() => setSelectedModel(null)}
                  >
                    清空筛选
                  </button>
                ) : null}
              </div>
              <table className="gateway-traffic-table">
                <thead>
                  <tr>
                    <th>模型</th>
                    <th>请求</th>
                    <th>成功</th>
                    <th>P95</th>
                    <th>总 Token</th>
                    <th>成本</th>
                  </tr>
                </thead>
                <tbody>
                  {gatewayTraffic.by_model.slice(0, 8).map((item) => {
                    const isSelected = selectedModel === item.key
                    return (
                      <tr
                        key={`model-${item.key}`}
                        className={isSelected ? 'is-selected' : undefined}
                        onClick={() => setSelectedModel(isSelected ? null : item.key)}
                        role="button"
                        tabIndex={0}
                      >
                        <td>{item.key}</td>
                        <td>{item.requests}</td>
                        <td>{item.success_requests}</td>
                        <td>{item.p95_latency_ms ? `${item.p95_latency_ms}ms` : '--'}</td>
                        <td>{formatTokens(item.total_tokens)}</td>
                        <td>{formatCost(item.estimated_cost_usd)}</td>
                      </tr>
                    )
                  })}
                  {gatewayTraffic.by_model.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="gateway-log-empty">
                        暂无模型级流量
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <div className="usage-mini-panel">
              <div className="usage-mini-panel-header">
                <h3>按提供商排行</h3>
                {selectedProvider ? <span>当前: {selectedProvider}</span> : null}
                {selectedProvider ? (
                  <button
                    type="button"
                    className="usage-text-btn"
                    onClick={() => setSelectedProvider(null)}
                  >
                    清空筛选
                  </button>
                ) : null}
              </div>
              <table className="gateway-traffic-table">
                <thead>
                  <tr>
                    <th>提供商</th>
                    <th>请求</th>
                    <th>成功</th>
                    <th>P95</th>
                    <th>总 Token</th>
                    <th>成本</th>
                  </tr>
                </thead>
                <tbody>
                  {gatewayTraffic.by_provider.slice(0, 6).map((item) => {
                    const isSelected = selectedProvider === item.key
                    return (
                      <tr
                        key={`provider-${item.key}`}
                        className={isSelected ? 'is-selected' : undefined}
                        onClick={() => setSelectedProvider(isSelected ? null : item.key)}
                        role="button"
                        tabIndex={0}
                      >
                        <td>{item.key}</td>
                        <td>{item.requests}</td>
                        <td>{item.success_requests}</td>
                        <td>{item.p95_latency_ms ? `${item.p95_latency_ms}ms` : '--'}</td>
                        <td>{formatTokens(item.total_tokens)}</td>
                        <td>{formatCost(item.estimated_cost_usd)}</td>
                      </tr>
                    )
                  })}
                  {gatewayTraffic.by_provider.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="gateway-log-empty">
                        暂无提供商流量
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <div className="usage-mini-panel">
              <h3>异常 Top</h3>
              <table className="gateway-traffic-table">
                <thead>
                  <tr>
                    <th>错误码</th>
                    <th>请求</th>
                    <th>占比</th>
                  </tr>
                </thead>
                <tbody>
                  {gatewayTraffic.top_errors.slice(0, 8).map((item) => (
                    <tr key={`error-${item.code}`}>
                      <td>{item.code}</td>
                      <td>{item.requests}</td>
                      <td>{formatErrorRatio(item.requests, gatewayTraffic.total_requests)}</td>
                    </tr>
                  ))}
                  {gatewayTraffic.top_errors.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="gateway-log-empty">
                        暂无异常数据
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <div className="usage-mini-panel">
              <h3>按应用排行</h3>
              <table className="gateway-traffic-table">
                <thead>
                  <tr>
                    <th>应用</th>
                    <th>请求</th>
                    <th>成功</th>
                    <th>P95</th>
                    <th>总 Token</th>
                    <th>成本</th>
                  </tr>
                </thead>
                <tbody>
                  {gatewayTraffic.by_app.slice(0, 6).map((item) => (
                    <tr key={`app-${item.key}`}>
                      <td>{integrationLabels[item.key] || item.key}</td>
                      <td>{item.requests}</td>
                      <td>{item.success_requests}</td>
                      <td>{item.p95_latency_ms ? `${item.p95_latency_ms}ms` : '--'}</td>
                      <td>{formatTokens(item.total_tokens)}</td>
                      <td>{formatCost(item.estimated_cost_usd)}</td>
                    </tr>
                  ))}
                  {gatewayTraffic.by_app.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="gateway-log-empty">
                        暂无应用流量
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <div className="usage-mini-panel">
              <div className="usage-mini-panel-header">
                <h3>按用户排行</h3>
                {selectedUser ? <span>当前: {selectedUser}</span> : null}
                {selectedUser ? (
                  <button
                    type="button"
                    className="usage-text-btn"
                    onClick={() => setSelectedUser(null)}
                  >
                    清空筛选
                  </button>
                ) : null}
              </div>
              <table className="gateway-traffic-table">
                <thead>
                  <tr>
                    <th>用户</th>
                    <th>请求</th>
                    <th>成功</th>
                    <th>P95</th>
                    <th>总 Token</th>
                    <th>成本</th>
                  </tr>
                </thead>
                <tbody>
                  {gatewayTraffic.by_user.slice(0, 6).map((item) => {
                    const isSelected = selectedUser === item.key
                    return (
                      <tr
                        key={`user-${item.key}`}
                        className={isSelected ? 'is-selected' : undefined}
                        onClick={() => setSelectedUser(isSelected ? null : item.key)}
                        role="button"
                        tabIndex={0}
                      >
                        <td>{item.key}</td>
                        <td>{item.requests}</td>
                        <td>{item.success_requests}</td>
                        <td>{item.p95_latency_ms ? `${item.p95_latency_ms}ms` : '--'}</td>
                        <td>{formatTokens(item.total_tokens)}</td>
                        <td>{formatCost(item.estimated_cost_usd)}</td>
                      </tr>
                    )
                  })}
                  {gatewayTraffic.by_user.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="gateway-log-empty">
                        暂无用户级流量
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <div className="usage-mini-panel">
              <h3>时间序列（近 {gatewayWindow} 分钟）</h3>
              <div className="gateway-timeline-mini">
                {gatewayTraffic.timeline.slice(-12).map((point) => (
                  <div key={point.minute} className="gateway-timeline-row">
                    <span>{point.minute.slice(11)}</span>
                    <span>{point.requests} req</span>
                    <span>{point.error_requests} err</span>
                    <span>{formatTokens(point.total_tokens)} token</span>
                    <span>{point.avg_latency_ms ? `${Math.round(point.avg_latency_ms)}ms` : '--'}</span>
                  </div>
                ))}
                {gatewayTraffic.timeline.length === 0 ? (
                  <div className="gateway-log-empty">暂无时间线数据</div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="usage-mini-panel usage-mini-log-panel">
            <h3>
              网关请求明细（最近）{selectedModel ? ` - ${selectedModel}` : ''}
              {selectedProvider ? ` / ${selectedProvider}` : ''}
              {selectedUser ? ` / ${selectedUser}` : ''}
            </h3>
            <table className="gateway-traffic-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>应用</th>
                  <th>供应商</th>
                  <th>模型</th>
                  <th>用户</th>
                  <th>端点</th>
                  <th>状态</th>
                  <th>耗时</th>
                  <th>Token</th>
                  <th>原因</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.slice(0, 20).map((item) => (
                  <tr key={item.id}>
                    <td>{new Date(item.created_at).toLocaleTimeString()}</td>
                    <td>{integrationLabels[item.app_type] || item.app_type}</td>
                    <td>{item.provider}</td>
                    <td>{item.model || '-'}</td>
                    <td>{item.user_key || '-'}</td>
                    <td>
                      <code>{item.endpoint}</code>
                    </td>
                    <td>{item.status_code}</td>
                    <td>{item.latency_ms}ms</td>
                    <td>{formatTokens(item.total_tokens)}</td>
                    <td>{item.blocked_reason || item.error_code || '-'}</td>
                  </tr>
                ))}
                {filteredLogs.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="gateway-log-empty">
                      {selectedModel || selectedProvider || selectedUser
                        ? '该筛选条件暂无最近请求'
                        : '暂无网关请求记录'}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

export default function UsageDashboard({
  masterPassword,
  providerContextById = {},
  quickStats = [],
  onNavigate,
}: UsageDashboardProps) {
  const [statuses, setStatuses] = useState<ProviderUsageStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const excludedProviders = new Set(['opencode', 'openclaw'])

  const fetchSummary = async () => {
    try {
      setLoading(true);
      const data = await invoke<ProviderUsageStatus[]>('usage_get_summary');
      setStatuses(data);
    } catch (err) {
      console.error('Failed to load summary:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleRefreshAll = async () => {
    try {
      setLoading(true);
      const data = await invoke<ProviderUsageStatus[]>('usage_refresh_all');
      setStatuses(data);
    } catch (err) {
      console.error("Refresh failed", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSummary();
  }, []);

  const enabledStatuses = statuses.filter(
    (status) => status.enabled && !excludedProviders.has(status.provider_id)
  );
  const healthyCount = enabledStatuses.filter(
    (status) => !status.error && (status.snapshot?.quotas.length ?? 0) > 0
  ).length;
  const degradedCount = enabledStatuses.filter(
    (status) => Boolean(status.error) || (status.snapshot ? status.snapshot.quotas.length === 0 : false)
  ).length;
  const quotaWindowCount = enabledStatuses.reduce(
    (sum, status) => sum + (status.snapshot?.quotas.length ?? 0),
    0
  );
  const claudeStatuses = enabledStatuses.filter((status) => status.provider_id.includes('anthropic'));
  const claudeCoverage = claudeStatuses.filter((status) => (status.snapshot?.quotas.length ?? 0) > 0).length;

  const summaryItems: Array<{
    key: string
    label: string
    value: number
    view: 'providers' | 'keys' | 'projects' | 'mcp' | 'skills' | 'apps'
  }> = [
    { key: 'providers', label: '供应商', value: enabledStatuses.length, view: 'providers' },
    ...quickStats,
  ]

  return (
    <div className="usage-dashboard">
      <header className="usage-header">
        <div className="usage-header-copy">
          <h1 className="usage-heading">Usage & Cost</h1>
          <p className="usage-subtitle">
            用量优先基于本机 OAuth/CLI 会话抓取，必要时回退到密钥库中的 API Key。
          </p>
          <div className="usage-header-meta-line">
            <div className="usage-summary-row">
              {summaryItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className="usage-summary-chip"
                  onClick={() => onNavigate?.(item.view)}
                >
                  <span className="usage-summary-value">{item.value}</span>
                  <span className="usage-summary-label">{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <button
          type="button"
          className={`usage-refresh-btn ${loading ? 'is-loading' : ''}`}
          onClick={handleRefreshAll}
          disabled={loading}
        >
          <span className="usage-symbol usage-refresh-icon" aria-hidden>↻</span>
          全部刷新
        </button>
      </header>

      {enabledStatuses.length > 0 ? (
        <section className="usage-kpi-row">
          <article className="usage-kpi-card usage-kpi-healthy">
            <p>Healthy</p>
            <strong>{healthyCount}</strong>
          </article>
          <article className="usage-kpi-card usage-kpi-degraded">
            <p>Needs Attention</p>
            <strong>{degradedCount}</strong>
          </article>
          <article className="usage-kpi-card usage-kpi-windows">
            <p>Quota Windows</p>
            <strong>{quotaWindowCount}</strong>
          </article>
          <article className={`usage-kpi-card ${claudeStatuses.length > 0 && claudeCoverage === 0 ? 'usage-kpi-alert' : 'usage-kpi-claude'}`}>
            <p>Claude Coverage</p>
            <strong>{claudeStatuses.length > 0 ? `${claudeCoverage}/${claudeStatuses.length}` : 'N/A'}</strong>
          </article>
        </section>
      ) : null}

      {enabledStatuses.length === 0 ? (
        <div className="usage-empty">
          <span className="usage-symbol usage-empty-symbol" aria-hidden>◎</span>
          <p>还没有启用的监控来源，前往 Provider 或全局设置开启后即可展示。</p>
        </div>
      ) : (
        <div className="usage-grid">
          {enabledStatuses.map((status, index) => (
            <UsageCard
              key={status.provider_id}
              providerId={status.provider_id}
              error={status.error}
              snapshot={status.snapshot}
              loading={loading}
              onRefresh={handleRefreshAll}
              context={
                providerContextById[status.provider_id] ?? {
                  keyCount: 0,
                  projectCount: 0,
                  pathCount: 0,
                  projectNames: [],
                  paths: [],
                }
              }
              index={index}
            />
          ))}
        </div>
      )}

      <GatewayAnalyticsSection
        masterPassword={masterPassword}
        onError={(msg) => {
          if (msg) {
            console.error(msg)
          }
        }}
      />
    </div>
  );
}
