export type VaultAuthMethod = 'master-password' | 'passkey-prf'

export interface VaultPasskeyUnlockInfo {
  rpId: string
  userId: string
  credentialId: string
  prfSalt: string
}

export interface VaultUnlockState {
  configured: boolean
  passkeys: VaultPasskeyUnlockInfo[]
  hasRecoveryKey: boolean
}

export function describeVaultUnlockState(state: VaultUnlockState) {
  return {
    configuredLabel: state.configured ? '已启用加密' : '尚未启用加密',
    passkeyLabel: `${state.passkeys.length} 个 passkey`,
    recoveryLabel: state.hasRecoveryKey ? '已生成恢复密钥' : '未生成恢复密钥',
  }
}

export function canRegisterVaultPasskey(
  authMethod: VaultAuthMethod,
  state: VaultUnlockState | null,
  busy: boolean
) {
  return authMethod === 'master-password' && Boolean(state?.configured) && !busy
}

export function shouldShowVaultPasskeyLogin(
  mode: 'setup' | 'login',
  state: VaultUnlockState | null
) {
  return mode === 'login' && Boolean(state?.configured && state.passkeys.length > 0)
}

export function classifyPasskeyError(error: unknown) {
  const name = error instanceof DOMException ? error.name : ''
  const message = String(error instanceof Error ? error.message : error)
  const isContextDenied =
    name === 'NotAllowedError' &&
    /not allowed by the user agent|platform in the current context|current context/i.test(message)

  if (isContextDenied) {
    return {
      kind: 'context-not-allowed' as const,
      canUseBrowserBridge: true,
    }
  }

  return {
    kind: 'other' as const,
    canUseBrowserBridge: false,
  }
}
