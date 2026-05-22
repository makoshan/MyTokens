export function normalizeProjectLabel(label?: string | null): string | null {
  const trimmed = label?.trim()
  return trimmed ? trimmed : null
}

export function deriveProjectLabelFromSource(source?: string | null): string {
  if (!source) return '未归类'
  const normalized = source.replace(/\\/g, '/').replace(/^\.\/+/, '')
  const segments = normalized.split('/').filter(Boolean)
  if (!segments.length) return '未归类'
  const first = segments[0]
  if (first.startsWith('.env') || first.startsWith('.dev.vars')) {
    return '当前目录'
  }
  return first
}

const PROJECT_AUTO_SCAN_SUPPRESS_ONCE_KEY = 'mykey:project-auto-scan:suppress-once'

export function suppressProjectAutoScanOnce() {
  try {
    localStorage.setItem(PROJECT_AUTO_SCAN_SUPPRESS_ONCE_KEY, '1')
  } catch {
    // ignore storage errors
  }
}

export function consumeProjectAutoScanSuppression(): boolean {
  try {
    const shouldSuppress = localStorage.getItem(PROJECT_AUTO_SCAN_SUPPRESS_ONCE_KEY) === '1'
    if (shouldSuppress) {
      localStorage.removeItem(PROJECT_AUTO_SCAN_SUPPRESS_ONCE_KEY)
      return true
    }
  } catch {
    // ignore storage errors
  }
  return false
}
