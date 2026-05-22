// Passkey-based EVM wallet using imToken's tcx-wasm (TokenCore) + WebAuthn PRF.
// The passkey PRF output encrypts a keystore (no seed phrase to remember); the
// derived key is a plain EOA on Ethereum Sepolia that signs burnWithMemo txs to
// redeem MYC for AI credits.
import initWasm, {
  create_keystore,
  derive_accounts,
  sign_message,
} from '@consenlabs/tcx-wasm/tcx_wasm.js'
import wasmUrl from '@consenlabs/tcx-wasm/tcx_wasm_bg.wasm?url'
import {
  createPublicClient,
  http,
  keccak256,
  encodeAbiParameters,
  stringToHex,
  padHex,
  type Hex,
} from 'viem'

const RP_ID = window.location.hostname
const PRF_SALT = new TextEncoder().encode('mykey-myc-wallet-v1')
const LS_KEY = 'mykey_passkey_wallet'
const DERIVATION_PATH = "m/44'/60'/0'/0/0"

// Ethereum Sepolia (validation chain). MYC ERC-20 (with burnWithSig) deployed here.
export const CHAIN_ID = 11155111
export const RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com'
export const MYC_TOKEN = '0x826fc283d2007A261347Cf4c0ff316e486506eBb' as const

const BURN_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'nonces', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

export interface BurnAuth {
  from: string
  value: string
  memo: Hex
  deadline: string
  sig: Hex
}

interface StoredWallet {
  credentialId: string // base64url
  keystoreJson: string
  address: string
}

let wasmReady: Promise<unknown> | null = null
function ensureWasm() {
  if (!wasmReady) wasmReady = initWasm({ module_or_path: wasmUrl })
  return wasmReady
}

const publicClient = createPublicClient({ transport: http(RPC_URL) })

function bufToB64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64urlToBuf(s: string): ArrayBuffer {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}
function toHex32(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function loadStoredWallet(): StoredWallet | null {
  const raw = localStorage.getItem(LS_KEY)
  return raw ? (JSON.parse(raw) as StoredWallet) : null
}

// --- Wallet session (login / logout) ---
//
// "Login" = the wallet is connected on this device; "logout" = disconnected.
// Disconnect is NON-destructive: it keeps the keystore so re-connecting restores
// the same wallet (and funds). Signing always re-prompts the passkey regardless,
// so disconnect is a visibility/session toggle, not the security boundary.
const LS_CONNECTED = 'mykey_wallet_connected'

export function isWalletConnected(): boolean {
  return loadStoredWallet() != null && localStorage.getItem(LS_CONNECTED) !== '0'
}

/**
 * Connect (login): use the cached wallet if present, else restore the SAME
 * wallet from the passkey (works on a fresh device / after clearing storage).
 * Brand-new users (no passkey yet) are created via createWallet (welcome flow).
 */
export async function connectWallet(accountId: string): Promise<StoredWallet> {
  const wallet = loadStoredWallet() ?? (await loginWallet(accountId))
  localStorage.setItem(LS_CONNECTED, '1')
  return wallet
}

/** Disconnect (logout): forget the connection but keep the keystore (safe). */
export function disconnectWallet(): void {
  localStorage.setItem(LS_CONNECTED, '0')
}

export function prfSupported(): boolean {
  return typeof window.PublicKeyCredential !== 'undefined' && !!navigator.credentials
}

// --- WebAuthn PRF ---

async function createPasskeyCredential(accountId: string): Promise<string> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'MyKey Compute', id: RP_ID },
      user: { id: new TextEncoder().encode(accountId), name: accountId, displayName: accountId },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      timeout: 60000,
    },
  })) as PublicKeyCredential | null
  if (!cred) throw new Error('passkey_create_cancelled')
  return bufToB64url(cred.rawId)
}

async function getPrfKey(credentialId: string): Promise<string> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: RP_ID,
      allowCredentials: [{ type: 'public-key', id: b64urlToBuf(credentialId) }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
      timeout: 60000,
    },
  })) as PublicKeyCredential | null
  if (!assertion) throw new Error('passkey_get_cancelled')
  const results = assertion.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }
  const prf = results.prf?.results?.first
  if (!prf) throw new Error('prf_unsupported')
  return toHex32(prf)
}

// --- Wallet lifecycle (deterministic from the passkey) ---
//
// The wallet is derived deterministically from the passkey PRF output, NOT a
// random mnemonic. Apple syncs the PRF secret across a user's devices, so the
// same passkey → same PRF → same entropy → same address everywhere. localStorage
// only caches the result; clearing it (or a fresh device) restores the SAME
// wallet via loginWallet(). This is what makes "登录/退出" meaningful + cross-device.

// 128-bit BIP39 entropy from the PRF, domain-separated so the seed differs from
// the keystore-encryption key (both stem from the same PRF output).
function deriveEntropyFromPrf(prfKey: string): string {
  return keccak256(stringToHex('mykey-wallet-seed-v1:' + prfKey)).slice(2, 34)
}

async function deriveWalletFromPrf(accountId: string, credentialId: string, prfKey: string): Promise<StoredWallet> {
  const entropy = deriveEntropyFromPrf(prfKey)
  const keystoreJson = create_keystore(
    JSON.stringify({ prfKey, userId: accountId, credentialId, rpId: RP_ID, entropy, network: 'MAINNET' })
  )
  const accounts = JSON.parse(
    derive_accounts(
      JSON.stringify({
        keystoreJson,
        key: prfKey,
        derivations: [{ chain: 'ETHEREUM', derivationPath: DERIVATION_PATH, chainId: String(CHAIN_ID), network: 'MAINNET' }],
      })
    )
  ) as Array<{ address: string }>
  const wallet: StoredWallet = { credentialId, keystoreJson, address: accounts[0].address }
  localStorage.setItem(LS_KEY, JSON.stringify(wallet))
  return wallet
}

/** First-time: create a new passkey, then derive the wallet from its PRF. */
export async function createWallet(accountId: string): Promise<StoredWallet> {
  await ensureWasm()
  const credentialId = await createPasskeyCredential(accountId)
  const prfKey = await getPrfKey(credentialId)
  return deriveWalletFromPrf(accountId, credentialId, prfKey)
}

// Discoverable assertion — on a new device (no cached credentialId) the OS lists
// this RP's synced passkeys for the user to pick. Returns its id + PRF output.
async function getDiscoverablePrf(): Promise<{ credentialId: string; prfKey: string }> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: RP_ID,
      allowCredentials: [],
      userVerification: 'required',
      extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
      timeout: 60000,
    },
  })) as PublicKeyCredential | null
  if (!assertion) throw new Error('passkey_get_cancelled')
  const results = assertion.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }
  const prf = results.prf?.results?.first
  if (!prf) throw new Error('prf_unsupported')
  return { credentialId: bufToB64url(assertion.rawId), prfKey: toHex32(prf) }
}

/** Log in / restore: re-derive the SAME wallet from an existing (synced) passkey. */
export async function loginWallet(accountId: string): Promise<StoredWallet> {
  await ensureWasm()
  const { credentialId, prfKey } = await getDiscoverablePrf()
  return deriveWalletFromPrf(accountId, credentialId, prfKey)
}

export async function getMycBalance(address: string): Promise<bigint> {
  return publicClient.readContract({ address: MYC_TOKEN, abi: BURN_ABI, functionName: 'balanceOf', args: [address as Hex] })
}

/**
 * Sign a gasless burn authorization (EIP-191 personal_sign) with the passkey
 * wallet. No broadcast, no gas — the gateway relayer submits burnWithSig. The
 * digest matches the contract: keccak256(abi.encode(from, value, memo, nonce,
 * deadline, chainId, token)).
 */
export async function signBurnAuth(accountId: string, mycAmount: bigint): Promise<BurnAuth> {
  await ensureWasm()
  const wallet = loadStoredWallet()
  if (!wallet) throw new Error('no_wallet')

  const from = wallet.address as Hex
  const nonce = await publicClient.readContract({ address: MYC_TOKEN, abi: BURN_ABI, functionName: 'nonces', args: [from] })
  const memo = padHex(stringToHex(accountId.slice(0, 31)), { dir: 'right', size: 32 })
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)

  const digest = keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }],
      [from, mycAmount, memo, nonce, deadline, BigInt(CHAIN_ID), MYC_TOKEN]
    )
  )

  const prfKey = await getPrfKey(wallet.credentialId)
  const signed = JSON.parse(
    sign_message(
      JSON.stringify({
        keystoreJson: wallet.keystoreJson,
        key: prfKey,
        chain: 'ETHEREUM',
        derivationPath: DERIVATION_PATH,
        input: { message: digest, signatureType: 'PersonalSign' },
      })
    )
  ) as { signature: Hex }

  return { from, value: mycAmount.toString(), memo, deadline: deadline.toString(), sig: signed.signature }
}

// --- Stablecoin (test USDT) → buy MYC ---
//
// The stablecoin is another MyKeyComputeCredit-style contract with the same
// gasless transferWithSig scheme, so the no-ETH passkey wallet can pay the
// relayer for MYC. Token address + the relayer sink come from the gateway
// (/dashboard/onchain-config) so the client and Worker never disagree.

// keccak256("MockStablecoin.transferWithSig.v1") — must match the contract's tag.
const STABLECOIN_TRANSFER_TAG = keccak256(stringToHex('MockStablecoin.transferWithSig.v1'))

export interface TransferAuth {
  from: string
  to: string
  value: string
  deadline: string
  sig: Hex
}

export async function getStablecoinBalance(tokenAddress: string, address: string): Promise<bigint> {
  return publicClient.readContract({ address: tokenAddress as Hex, abi: BURN_ABI, functionName: 'balanceOf', args: [address as Hex] })
}

/**
 * Sign a gasless stablecoin transfer authorization (EIP-191 personal_sign) paying
 * `to` (the relayer sink). No broadcast, no gas — the gateway relayer submits
 * transferWithSig. The digest matches the contract: keccak256(abi.encode(TAG,
 * from, to, value, nonce, deadline, chainId, token)).
 */
export async function signStablecoinTransferAuth(tokenAddress: string, to: string, value: bigint): Promise<TransferAuth> {
  await ensureWasm()
  const wallet = loadStoredWallet()
  if (!wallet) throw new Error('no_wallet')

  const from = wallet.address as Hex
  const token = tokenAddress as Hex
  const nonce = await publicClient.readContract({ address: token, abi: BURN_ABI, functionName: 'nonces', args: [from] })
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)

  const digest = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }],
      [STABLECOIN_TRANSFER_TAG, from, to as Hex, value, nonce, deadline, BigInt(CHAIN_ID), token]
    )
  )

  const prfKey = await getPrfKey(wallet.credentialId)
  const signed = JSON.parse(
    sign_message(
      JSON.stringify({
        keystoreJson: wallet.keystoreJson,
        key: prfKey,
        chain: 'ETHEREUM',
        derivationPath: DERIVATION_PATH,
        input: { message: digest, signatureType: 'PersonalSign' },
      })
    )
  ) as { signature: Hex }

  return { from, to, value: value.toString(), deadline: deadline.toString(), sig: signed.signature }
}
