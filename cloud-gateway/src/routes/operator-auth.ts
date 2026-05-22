// Operator auth: an operator's identity is an EVM keypair generated locally by
// the native app and kept in its encrypted vault. The app proves ownership by
// EIP-191 personal_sign over a freshness-bound challenge; the gateway recovers
// the signer and issues an operator session. No invite link, no leakable
// long-lived token — the local key is the durable identity.
import { recoverMessageAddress, type Hex } from 'viem'
import { GatewayError } from '../errors.js'

const CHALLENGE_WINDOW_MS = 5 * 60 * 1000

/** Canonical challenge the native app signs. Binds the address + an issue time. */
export function buildOperatorChallenge(address: string, issuedAt: string): string {
  return `MyKey operator auth\naddress: ${address.toLowerCase()}\nissued: ${issuedAt}`
}

/** Throws GatewayError unless `sig` is a fresh personal_sign over `challenge` by `address`. */
export async function verifyOperatorChallenge(input: {
  address: string
  challenge: string
  sig: string
  now: string
}): Promise<void> {
  const addr = input.address.trim().toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(addr)) throw new GatewayError('operator_invalid_address', 400)
  // The challenge must bind this exact address so a signature can't be reused
  // to claim a different operator identity.
  if (!input.challenge.toLowerCase().includes(addr)) {
    throw new GatewayError('operator_challenge_mismatch', 400)
  }
  const match = /issued:\s*([0-9T:.+\-]+Z?)/i.exec(input.challenge)
  const issued = match ? Date.parse(match[1]) : NaN
  if (!Number.isFinite(issued)) throw new GatewayError('operator_challenge_invalid', 400)
  if (Math.abs(Date.parse(input.now) - issued) > CHALLENGE_WINDOW_MS) {
    throw new GatewayError('operator_challenge_expired', 401)
  }
  let recovered: string
  try {
    recovered = (
      await recoverMessageAddress({ message: input.challenge, signature: input.sig as Hex })
    ).toLowerCase()
  } catch {
    throw new GatewayError('operator_bad_signature', 401)
  }
  if (recovered !== addr) throw new GatewayError('operator_bad_signature', 401)
}
