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
