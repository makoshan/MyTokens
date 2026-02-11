interface PaceProgressBarProps {
    percent: number
    expectedPercent?: number
    status: 'healthy' | 'warning' | 'critical' | 'depleted'
}

export default function PaceProgressBar({
    percent,
    expectedPercent,
    status,
}: PaceProgressBarProps) {
    const clamped = Math.min(100, Math.max(0, percent))
    const expected = expectedPercent !== undefined
        ? Math.min(100, Math.max(0, expectedPercent))
        : undefined

    return (
        <div className={`pace-progress pace-${status}`}>
            {expected !== undefined && (
                <div
                    className="pace-progress-ghost"
                    style={{ width: `${expected}%` }}
                />
            )}
            <div className="pace-progress-fill" style={{ width: `${clamped}%` }} />
        </div>
    )
}
