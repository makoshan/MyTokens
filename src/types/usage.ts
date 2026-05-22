export interface UsageQuota {
    quota_type: string;
    label: string;
    percent_remaining: number;
    reset_at?: string | null;
    reset_text?: string | null;
}

export interface CostUsage {
    total_cost: number;
    budget?: number | null;
}

export interface UsageSnapshot {
    provider_id: string;
    captured_at: string;
    quotas: UsageQuota[];
    cost_usage?: CostUsage | null;
    account_tier?: string | null;
    account_email?: string | null;
}

export interface ProviderUsageStatus {
    provider_id: string;
    enabled: boolean;
    error?: string | null;
    snapshot?: UsageSnapshot | null;
}
