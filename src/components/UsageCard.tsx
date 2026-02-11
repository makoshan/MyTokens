import { UsageSnapshot, UsageQuota } from '../types/usage';
import PaceProgressBar from './PaceProgressBar';
import { getProviderColor, getProviderDisplayName } from '../utils/provider';
import { getQuotaStatus } from '../utils/usage';
import type { ProviderLinkageContext } from '../utils/linkage';

interface UsageCardProps {
    providerId: string;
    error?: string | null;
    snapshot?: UsageSnapshot | null;
    onRefresh: () => void;
    loading: boolean;
    index: number;
    context?: ProviderLinkageContext;
}

type CardStatus = 'healthy' | 'warning' | 'critical' | 'depleted'

export default function UsageCard({ providerId, error, snapshot, onRefresh, loading, index, context }: UsageCardProps) {
    const getPaceStatus = (quota: UsageQuota) => getQuotaStatus(quota.percent_remaining)

    const meta = {
        label: getProviderDisplayName(providerId),
        accent: getProviderColor(providerId)
    }
    const minRemaining = snapshot?.quotas.length
        ? Math.min(...snapshot.quotas.map((quota) => quota.percent_remaining))
        : null
    const health: CardStatus = error
        ? 'critical'
        : minRemaining === null
            ? 'depleted'
            : getQuotaStatus(minRemaining)

    const healthLabel: Record<CardStatus, string> = {
        healthy: 'Healthy',
        warning: 'Warning',
        critical: 'Critical',
        depleted: 'Empty'
    }

    return (
        <article
            className={`usage-card usage-card-${health}`}
            style={{
                animationDelay: `${Math.min(index * 70, 560)}ms`,
                ['--provider-accent' as string]: meta.accent
            }}
        >
            <div className="usage-card-header">
                <div className="usage-provider-info">
                    <span className="usage-provider-dot" />
                    <h3>{meta.label}</h3>
                </div>
                <span className={`usage-health-pill usage-health-${health}`}>{healthLabel[health]}</span>
            </div>

            {context ? (
                <div className="usage-context-row">
                    <span className="usage-context-pill">Keys {context.keyCount}</span>
                    <span className="usage-context-pill">Projects {context.projectCount}</span>
                    <span className="usage-context-pill">Paths {context.pathCount}</span>
                </div>
            ) : null}

            <div className="usage-card-actions">
                <button
                    onClick={onRefresh}
                    disabled={loading}
                    className={`usage-refresh-mini ${loading ? 'is-loading' : ''}`}
                    title="Refresh provider usage"
                >
                    <span className="usage-symbol" aria-hidden>↻</span>
                </button>
            </div>

            {error ? (
                <div className="usage-error">
                    <span className="usage-symbol" aria-hidden>⚠</span>
                    <p>{error}</p>
                </div>
            ) : snapshot ? (
                <div className="usage-card-body">
                    {snapshot.cost_usage && (
                        <section className="usage-cost-box">
                            <div>
                                <div className="usage-cost-label">Current Cost</div>
                                <div className="usage-cost-value">
                                    ${snapshot.cost_usage.total_cost.toFixed(2)}
                                </div>
                            </div>
                            {snapshot.cost_usage.budget ? (
                                <div className="usage-cost-budget">
                                    <div className="usage-cost-label">Budget</div>
                                    <div className="usage-cost-budget-value">
                                        ${snapshot.cost_usage.budget.toFixed(2)}
                                    </div>
                                </div>
                            ) : null}
                        </section>
                    )}

                    <section className="usage-quota-list">
                        {snapshot.quotas.length === 0 ? (
                            <div className="usage-quota-empty">No quota windows returned</div>
                        ) : (
                            snapshot.quotas.map((quota, idx) => {
                                const status = getPaceStatus(quota)
                                const used = 100 - quota.percent_remaining
                                return (
                                    <div key={idx} className="usage-quota-item">
                                        <div className="usage-quota-head">
                                            <span className="usage-quota-label">{quota.label}</span>
                                            <span className="usage-quota-value">{quota.percent_remaining.toFixed(1)}% left</span>
                                        </div>
                                        <PaceProgressBar
                                            percent={used}
                                            status={status}
                                        />
                                        {quota.reset_text ? (
                                            <div className="usage-reset-text">Resets in {quota.reset_text}</div>
                                        ) : null}
                                    </div>
                                )
                            })
                        )}
                    </section>

                    <footer className="usage-card-footer">
                        <span className="usage-updated">
                            Updated {new Date(snapshot.captured_at).toLocaleTimeString()}
                        </span>
                    </footer>
                </div>
            ) : (
                <div className="usage-empty-state">
                    <span className="usage-symbol" aria-hidden>⌛</span>
                    <p>No data available. Click refresh.</p>
                </div>
            )}
        </article>
    );
}
