import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  canEnableBiometricKeychain,
  canRegisterVaultPasskey,
  classifyPasskeyError,
  describeVaultUnlockState,
  shouldShowBiometricLogin,
  shouldShowVaultPasskeyLogin,
  type VaultUnlockState,
} from '../src/utils/vaultUnlock'

const configuredState: VaultUnlockState = {
  configured: true,
  hasRecoveryKey: true,
  passkeys: [
    {
      rpId: 'localhost',
      userId: 'user-1',
      credentialId: 'credential-1',
      prfSalt: 'salt-1',
    },
  ],
}

test('describeVaultUnlockState reports password, passkey and recovery availability', () => {
  assert.deepEqual(describeVaultUnlockState(configuredState), {
    configuredLabel: '已启用加密',
    passkeyLabel: '1 个 passkey',
    recoveryLabel: '已生成恢复密钥',
  })
})

test('canRegisterVaultPasskey only allows master-password sessions that are not busy', () => {
  assert.equal(canRegisterVaultPasskey('master-password', configuredState, false), true)
  assert.equal(canRegisterVaultPasskey('passkey-prf', configuredState, false), false)
  assert.equal(canRegisterVaultPasskey('biometric-keychain', configuredState, false), false)
  assert.equal(canRegisterVaultPasskey('master-password', configuredState, true), false)
  assert.equal(canRegisterVaultPasskey('master-password', { ...configuredState, configured: false }, false), false)
})

test('canEnableBiometricKeychain only allows configured master-password sessions that are not busy', () => {
  assert.equal(canEnableBiometricKeychain('master-password', configuredState, false), true)
  assert.equal(canEnableBiometricKeychain('passkey-prf', configuredState, false), false)
  assert.equal(canEnableBiometricKeychain('biometric-keychain', configuredState, false), false)
  assert.equal(canEnableBiometricKeychain('master-password', configuredState, true), false)
  assert.equal(canEnableBiometricKeychain('master-password', { ...configuredState, configured: false }, false), false)
})

test('shouldShowVaultPasskeyLogin only shows passkey login after a passkey is configured', () => {
  assert.equal(shouldShowVaultPasskeyLogin('login', configuredState), true)
  assert.equal(shouldShowVaultPasskeyLogin('setup', configuredState), false)
  assert.equal(shouldShowVaultPasskeyLogin('login', null), false)
  assert.equal(shouldShowVaultPasskeyLogin('login', { ...configuredState, passkeys: [] }), false)
  assert.equal(shouldShowVaultPasskeyLogin('login', { ...configuredState, configured: false }), false)
})

test('shouldShowBiometricLogin only shows Touch ID login when a keychain item exists', () => {
  assert.equal(shouldShowBiometricLogin('login', true), true)
  assert.equal(shouldShowBiometricLogin('setup', true), false)
  assert.equal(shouldShowBiometricLogin('login', false), false)
})

test('classifyPasskeyError identifies WKWebView NotAllowedError as browser-bridge fallback eligible', () => {
  const err = new DOMException(
    'The request is not allowed by the user agent or the platform in the current context',
    'NotAllowedError'
  )

  assert.deepEqual(classifyPasskeyError(err), {
    kind: 'context-not-allowed',
    canUseBrowserBridge: true,
  })
})
