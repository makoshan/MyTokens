// IPv4 CIDR allowlist for /admin/* routes.
//
// Default behavior: empty allowlist = no enforcement (dev-friendly). Production
// deployments MUST set ADMIN_IP_ALLOWLIST so a leaked admin token alone cannot
// drive the control plane.

export interface CidrSpec {
  base: number
  prefix: number
}

function parseIpv4(value: string): number | null {
  const parts = value.trim().split('.')
  if (parts.length !== 4) return null
  let result = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet < 0 || octet > 255) return null
    result = (result << 8) | octet
  }
  return result >>> 0
}

export function parseCidrList(input: string | string[] | undefined | null): CidrSpec[] {
  if (!input) return []
  const tokens = Array.isArray(input)
    ? input
    : input
        .split(',')
        .map((token) => token.trim())
        .filter(Boolean)
  const out: CidrSpec[] = []
  for (const token of tokens) {
    const [ipPart, prefixPart] = token.split('/')
    const base = parseIpv4(ipPart)
    if (base === null) continue
    const prefix = prefixPart === undefined ? 32 : Number(prefixPart)
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) continue
    out.push({ base, prefix })
  }
  return out
}

export function matchesCidr(ip: string, spec: CidrSpec): boolean {
  const value = parseIpv4(ip)
  if (value === null) return false
  if (spec.prefix === 0) return true
  const mask = spec.prefix === 32 ? 0xffffffff : ((-1 << (32 - spec.prefix)) >>> 0)
  return (value & mask) === (spec.base & mask)
}

export function matchesCidrList(ip: string, specs: CidrSpec[]): boolean {
  for (const spec of specs) {
    if (matchesCidr(ip, spec)) return true
  }
  return false
}

export interface AdminIpCheckInput {
  request: Request
  allowlist?: string[] | string | null
}

export function isAdminIpAllowed(input: AdminIpCheckInput): { allowed: true } | { allowed: false; reason: 'missing_ip' | 'not_allowed' } {
  const specs = parseCidrList(input.allowlist ?? null)
  if (specs.length === 0) return { allowed: true }
  const ip = input.request.headers.get('cf-connecting-ip') ?? input.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (!ip) return { allowed: false, reason: 'missing_ip' }
  return matchesCidrList(ip, specs) ? { allowed: true } : { allowed: false, reason: 'not_allowed' }
}
