// IP CIDR allowlist for /admin/* routes (IPv4 + IPv6).
//
// Default behavior: empty allowlist = no enforcement (dev-friendly). Production
// deployments MUST set ADMIN_IP_ALLOWLIST so a leaked admin token alone cannot
// drive the control plane. Both families are supported because residential and
// mobile networks are increasingly IPv6-only — an operator who allowlisted only
// IPv4 and then connected over IPv6 would otherwise lock themselves out.

export type IpFamily = 'v4' | 'v6'

export interface CidrSpec {
  family: IpFamily
  base: bigint
  prefix: number
}

const FAMILY_BITS: Record<IpFamily, number> = { v4: 32, v6: 128 }

function parseIpv4ToBigInt(value: string): bigint | null {
  const parts = value.trim().split('.')
  if (parts.length !== 4) return null
  let result = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet < 0 || octet > 255) return null
    result = (result << 8n) | BigInt(octet)
  }
  return result
}

function parseHextetGroups(part: string): bigint[] | null {
  if (part === '') return []
  const groups = part.split(':')
  const out: bigint[] = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    out.push(BigInt(parseInt(group, 16)))
  }
  return out
}

function parseIpv6ToBigInt(value: string): bigint | null {
  let text = value.trim().toLowerCase()
  // Drop an interface zone id (fe80::1%eth0) — irrelevant for allowlisting.
  const zone = text.indexOf('%')
  if (zone >= 0) text = text.slice(0, zone)
  if (!text.includes(':')) return null

  // Expand a trailing dotted-quad (::ffff:192.168.0.1) into two hextets.
  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':')
    const v4 = parseIpv4ToBigInt(text.slice(lastColon + 1))
    if (v4 === null) return null
    const hi = (v4 >> 16n) & 0xffffn
    const lo = v4 & 0xffffn
    text = `${text.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`
  }

  const halves = text.split('::')
  if (halves.length > 2) return null

  let groups: bigint[]
  if (halves.length === 2) {
    const head = parseHextetGroups(halves[0])
    const tail = parseHextetGroups(halves[1])
    if (head === null || tail === null) return null
    const missing = 8 - head.length - tail.length
    if (missing < 0) return null
    groups = [...head, ...Array.from({ length: missing }, () => 0n), ...tail]
  } else {
    const all = parseHextetGroups(text)
    if (all === null) return null
    groups = all
  }
  if (groups.length !== 8) return null

  let result = 0n
  for (const group of groups) {
    result = (result << 16n) | group
  }
  return result
}

function maskFor(bits: number, prefix: number): bigint {
  const total = BigInt(bits)
  const p = BigInt(prefix)
  if (p <= 0n) return 0n
  if (p >= total) return (1n << total) - 1n
  return ((1n << p) - 1n) << (total - p)
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
    const slash = token.lastIndexOf('/')
    const ipPart = slash >= 0 ? token.slice(0, slash) : token
    const prefixPart = slash >= 0 ? token.slice(slash + 1) : undefined
    const family: IpFamily = ipPart.includes(':') ? 'v6' : 'v4'
    const base = family === 'v6' ? parseIpv6ToBigInt(ipPart) : parseIpv4ToBigInt(ipPart)
    if (base === null) continue
    const bits = FAMILY_BITS[family]
    const prefix = prefixPart === undefined ? bits : Number(prefixPart)
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) continue
    out.push({ family, base, prefix })
  }
  return out
}

export function matchesCidr(ip: string, spec: CidrSpec): boolean {
  const value = spec.family === 'v6' ? parseIpv6ToBigInt(ip) : parseIpv4ToBigInt(ip)
  if (value === null) return false
  if (spec.prefix === 0) return true
  const mask = maskFor(FAMILY_BITS[spec.family], spec.prefix)
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

export function isAdminIpAllowed(
  input: AdminIpCheckInput
): { allowed: true } | { allowed: false; reason: 'missing_ip' | 'not_allowed' } {
  const specs = parseCidrList(input.allowlist ?? null)
  if (specs.length === 0) return { allowed: true }
  const ip =
    input.request.headers.get('cf-connecting-ip') ??
    input.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (!ip) return { allowed: false, reason: 'missing_ip' }
  return matchesCidrList(ip, specs) ? { allowed: true } : { allowed: false, reason: 'not_allowed' }
}
