import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ProviderUsageStatus } from '../types/usage';
import UsageCard from './UsageCard';
import './UsageDashboard.css';
import type { ProviderLinkageContext } from '../utils/linkage';

interface UsageDashboardProps {
  providerContextById?: Record<string, ProviderLinkageContext>
}

export default function UsageDashboard({ providerContextById = {} }: UsageDashboardProps) {
  const [statuses, setStatuses] = useState<ProviderUsageStatus[]>([]);
  const [loading, setLoading] = useState(false);

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

  const enabledStatuses = statuses.filter((status) => status.enabled);
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
  const latestUpdate = enabledStatuses
    .map((status) => status.snapshot?.captured_at)
    .filter((value): value is string => Boolean(value))
    .sort()
    .slice(-1)[0];

  return (
    <div className="usage-dashboard">
      <header className="usage-header">
        <div className="usage-header-copy">
          <h1 className="usage-heading">Usage & Cost</h1>
          <p className="usage-subtitle">
            用量优先基于本机 OAuth/CLI 会话抓取，必要时回退到密钥库中的 API Key。
          </p>
          <div className="usage-header-meta">
            <span className="usage-pill">{enabledStatuses.length} Providers</span>
            {latestUpdate ? (
              <span className="usage-updated-at">
                Updated {new Date(latestUpdate).toLocaleTimeString()}
              </span>
            ) : null}
          </div>
        </div>
        <button
          className={`usage-refresh-btn ${loading ? 'is-loading' : ''}`}
          onClick={handleRefreshAll}
          disabled={loading}
        >
          <span className="usage-symbol usage-refresh-icon" aria-hidden>↻</span>
          Refetch All
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
    </div>
  );
}
