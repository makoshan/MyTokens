import initTcxWasm, {
  create_keystore,
  derive_accounts,
  sign_tx,
} from '@consenlabs/tcx-wasm'

let initialized: Promise<void> | null = null

export type TcxUnlockMode = 'password' | 'passkey-prf'

export interface TcxDerivation {
  chain: string
  derivationPath: string
  chainId?: string
  network: string
  segWit?: string
}

export interface TcxAccount {
  address: string
  chain: string
  derivationPath: string
  extPubKey?: string
  publicKey?: string
}

export interface TcxSignedTransaction {
  signature?: string
  txHash?: string
  [key: string]: unknown
}

function init() {
  if (!initialized) {
    initialized = initTcxWasm().then(() => undefined)
  }
  return initialized
}

function assertPrfKey(value: string) {
  if (!/^[0-9a-fA-F]{64}$/.test(value.trim())) {
    throw new Error('Passkey PRF key must be 32 bytes encoded as 64 hex characters.')
  }
}

export async function createTcxKeystore(input: {
  unlockMode: TcxUnlockMode
  unlockSecret: string
  mnemonic?: string
  entropy?: string
  network?: string
  userId?: string
  credentialId?: string
  rpId?: string
}) {
  await init()
  const unlockSecret = input.unlockSecret.trim()
  if (!unlockSecret) {
    throw new Error('Unlock secret is required.')
  }

  const payload: Record<string, unknown> = {
    network: input.network || 'MAINNET',
  }
  if (input.mnemonic?.trim()) payload.mnemonic = input.mnemonic.trim()
  if (input.entropy?.trim()) payload.entropy = input.entropy.trim()

  if (input.unlockMode === 'passkey-prf') {
    assertPrfKey(unlockSecret)
    payload.prfKey = unlockSecret
    payload.userId = input.userId?.trim() || 'mykey-user'
    payload.credentialId = input.credentialId?.trim() || 'mykey-credential'
    payload.rpId = input.rpId?.trim() || window.location.hostname || 'mykey.local'
  } else {
    payload.password = unlockSecret
  }

  return create_keystore(JSON.stringify(payload))
}

export async function deriveTcxAccounts(input: {
  keystoreJson: string
  unlockSecret: string
  derivations: TcxDerivation[]
}): Promise<TcxAccount[]> {
  await init()
  return JSON.parse(derive_accounts(JSON.stringify({
    keystoreJson: input.keystoreJson,
    key: input.unlockSecret,
    derivations: input.derivations,
  })))
}

export async function signTcxTransaction(input: {
  keystoreJson: string
  unlockSecret: string
  chain: string
  derivationPath: string
  txInput: unknown
}): Promise<TcxSignedTransaction> {
  await init()
  return JSON.parse(sign_tx(JSON.stringify({
    keystoreJson: input.keystoreJson,
    key: input.unlockSecret,
    chain: input.chain,
    derivationPath: input.derivationPath,
    input: input.txInput,
  })))
}
