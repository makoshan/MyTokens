import { invoke } from '@tauri-apps/api/core'

/**
 * Relying-Party identifier for native macOS passkeys. Must match the
 * `webcredentials:` Associated Domain in `src-tauri/Entitlements.plist` and the
 * AASA served by the Cloudflare worker (cloudflare/passkey-aasa). Currently the
 * workers.dev test domain; swap for the production domain (e.g. mykey.im) later.
 */
export const NATIVE_PASSKEY_RP_ID = 'mykey-passkey-aasa.v2eth.workers.dev'

/**
 * Shape returned by the native Tauri commands — intentionally identical to the
 * browser-bridge result so the two paths are interchangeable downstream.
 */
export interface NativePasskeyResult {
  credentialId: string
  userId: string
  rpId: string
  prfSalt: string
  prfKeyHex: string
}

/** A stored passkey is a native one (vs browser-bridge) iff its RP ID matches. */
export function isNativePasskey(rpId: string | null | undefined): boolean {
  return (rpId ?? '').trim() === NATIVE_PASSKEY_RP_ID
}

/**
 * Whether the native AuthenticationServices path is usable on this platform.
 * NOTE: `true` does not guarantee success — at runtime the call still requires
 * the app to be signed with the Associated Domains entitlement (paid Apple
 * Developer Program + provisioning). Until then native calls error and callers
 * should fall back to the browser bridge.
 */
export async function isNativePasskeyAvailable(): Promise<boolean> {
  try {
    return await invoke<boolean>('passkey_native_available')
  } catch {
    return false
  }
}

/** Register a new native platform passkey and derive its PRF key. */
export async function registerNativePasskey(
  userName: string,
  prfSalt?: string
): Promise<NativePasskeyResult> {
  return invoke<NativePasskeyResult>('passkey_native_register', {
    rpId: NATIVE_PASSKEY_RP_ID,
    userName: userName || 'MyKey',
    prfSalt: prfSalt ?? null,
  })
}

/** Assert an existing native platform passkey and re-derive its PRF key. */
export async function assertNativePasskey(
  credentialId: string,
  prfSalt: string,
  rpId?: string | null
): Promise<NativePasskeyResult> {
  return invoke<NativePasskeyResult>('passkey_native_assert', {
    rpId: rpId && rpId.trim() ? rpId : NATIVE_PASSKEY_RP_ID,
    credentialId,
    prfSalt,
  })
}
