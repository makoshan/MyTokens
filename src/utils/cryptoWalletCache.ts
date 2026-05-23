import type { TrustWalletTokenStatusMap } from './cryptoPortfolio'

// localStorage holding the Crypto view's scan-derived display data so it can
// rehydrate instantly on remount instead of re-querying Alchemy + Trust Wallet
// every time the view is opened. Token rows + balances already persist in the
// DB; this caches the overlays that otherwise only live in React state and get
// thrown away when the view unmounts (logos, USD values, the portfolio total,
// and Trust Wallet verification status — the last of which, when missing, hides
// every contract token until re-verification finishes).
export const cryptoWalletCacheStorageKey = 'mykey.crypto.scanCache.v1'

// After a successful scan we keep using the cached snapshot for this long before
// the next view-open triggers a background rescan. Manual Refresh always rescans.
export const CRYPTO_SCAN_TTL_MS = 10 * 60 * 1000

export interface CryptoWalletCache {
  // Keyed by DB token id (stable across remounts).
  logoByToken: Record<string, string[]>
  valueByToken: Record<string, string>
  // Last-scanned live token balance (display string). Lets a token row show its
  // real balance instantly on remount instead of falling back to a stale DB value
  // or "--" until the rescan returns.
  balanceByToken: Record<string, string>
  trustWalletStatusByToken: TrustWalletTokenStatusMap
  // Keyed by account id.
  totalUsdByAccount: Record<string, string>
  scannedAtByAccount: Record<string, number>
  // Last-scanned native balance (e.g. ETH) per account, so the native row shows
  // a number on open rather than blank until the chain query returns.
  balanceByAccount: Record<string, string>
}

export function emptyCryptoWalletCache(): CryptoWalletCache {
  return {
    logoByToken: {},
    valueByToken: {},
    balanceByToken: {},
    trustWalletStatusByToken: {},
    totalUsdByAccount: {},
    scannedAtByAccount: {},
    balanceByAccount: {},
  }
}

function asRecord<T>(value: unknown): Record<string, T> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, T>) : {}
}

// Parse a persisted blob defensively — a malformed or stale-shaped payload
// yields an empty cache rather than throwing and breaking the view.
export function parseCryptoWalletCache(raw: string | null | undefined): CryptoWalletCache {
  if (!raw) return emptyCryptoWalletCache()
  try {
    const data = JSON.parse(raw) as Partial<CryptoWalletCache>
    return {
      logoByToken: asRecord<string[]>(data.logoByToken),
      valueByToken: asRecord<string>(data.valueByToken),
      balanceByToken: asRecord<string>(data.balanceByToken),
      trustWalletStatusByToken: asRecord<'verified' | 'missing'>(data.trustWalletStatusByToken),
      totalUsdByAccount: asRecord<string>(data.totalUsdByAccount),
      scannedAtByAccount: asRecord<number>(data.scannedAtByAccount),
      balanceByAccount: asRecord<string>(data.balanceByAccount),
    }
  } catch {
    return emptyCryptoWalletCache()
  }
}

// Drop entries for tokens/accounts that no longer exist so the cache can't grow
// without bound as wallets, accounts and tokens come and go.
export function pruneCryptoWalletCache(
  cache: CryptoWalletCache,
  liveTokenIds: Set<string>,
  liveAccountIds: Set<string>
): CryptoWalletCache {
  const pick = <T>(map: Record<string, T>, live: Set<string>): Record<string, T> => {
    const out: Record<string, T> = {}
    for (const [id, value] of Object.entries(map)) if (live.has(id)) out[id] = value
    return out
  }
  return {
    logoByToken: pick(cache.logoByToken, liveTokenIds),
    valueByToken: pick(cache.valueByToken, liveTokenIds),
    balanceByToken: pick(cache.balanceByToken, liveTokenIds),
    trustWalletStatusByToken: pick(cache.trustWalletStatusByToken, liveTokenIds),
    totalUsdByAccount: pick(cache.totalUsdByAccount, liveAccountIds),
    scannedAtByAccount: pick(cache.scannedAtByAccount, liveAccountIds),
    balanceByAccount: pick(cache.balanceByAccount, liveAccountIds),
  }
}

// Whether the last successful scan for an account is recent enough to skip the
// auto-scan on view open. `now` is injectable for testing.
export function isAccountScanFresh(
  cache: CryptoWalletCache,
  accountId: string,
  ttlMs: number = CRYPTO_SCAN_TTL_MS,
  now: number = Date.now()
): boolean {
  const scannedAt = cache.scannedAtByAccount[accountId]
  return typeof scannedAt === 'number' && Number.isFinite(scannedAt) && now - scannedAt < ttlMs
}

export function loadCryptoWalletCache(): CryptoWalletCache {
  if (typeof window === 'undefined') return emptyCryptoWalletCache()
  return parseCryptoWalletCache(window.localStorage.getItem(cryptoWalletCacheStorageKey))
}

export function saveCryptoWalletCache(cache: CryptoWalletCache): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(cryptoWalletCacheStorageKey, JSON.stringify(cache))
  } catch {
    // Storage full / unavailable — the cache is best-effort, so ignore.
  }
}
