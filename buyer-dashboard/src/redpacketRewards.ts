// Pure helpers for the red-packet claim overlay (RedpacketClaim.tsx), extracted
// so they can be unit tested without a DOM or WebAuthn — same convention as
// dashboardViewModel.ts. The component stays a thin shell over these.

/** Tokens a single MYC (≈ $1) buys at the current sell price, for guidance copy. */
export const TOKENS_PER_MYC = 670_000

export interface RedpacketReward {
  /** 1 MYC = $1, so the dollar value equals the MYC amount. */
  usd: number
  /** Estimated tokens the credit buys, for the "what you got" copy. */
  tokens: number
  /** Localised "万 tokens" label, e.g. "1,340" for 20 MYC (~13.4M tokens). */
  tokensWanLabel: string
}

/** Derive the "what you got / what it buys" numbers shown after a successful claim. */
export function redpacketReward(myc: number): RedpacketReward {
  const tokens = Math.round(myc * TOKENS_PER_MYC)
  return {
    usd: myc,
    tokens,
    tokensWanLabel: (tokens / 10000).toLocaleString(),
  }
}

const ERROR_COPY: Record<string, string> = {
  prf_unsupported: '这个 passkey 不支持 PRF（换个浏览器/设备）',
  passkey_create_cancelled: '已取消',
  passkey_get_cancelled: '已取消签名',
  redpacket_not_found: '红包口令无效',
  redpacket_already_claimed: '这个红包已经被领过了',
  relayer_pool_insufficient: '红包池不足，联系发红包的人',
}

/** Map a backend / wallet error code to friendly buyer-facing copy; unknown errors pass through verbatim. */
export function humanError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  return ERROR_COPY[m] ?? m
}
