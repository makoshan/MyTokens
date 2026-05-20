export interface PasskeyPrfRegistration {
  credentialId: string
  rpId: string
  prfSalt: string
  prfKeyHex: string
}

function randomBytes(length: number) {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToBytes(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function bytesToHex(bytes: ArrayBuffer | Uint8Array) {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function getRpId() {
  const host = window.location.hostname
  if (!host || host === 'localhost' || host === '127.0.0.1') return undefined
  return host
}

function prfResultToHex(credential: PublicKeyCredential) {
  const extensionResults = credential.getClientExtensionResults() as {
    prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } }
  }
  const result = extensionResults.prf?.results?.first
  if (!result) {
    throw new Error('This passkey did not return a WebAuthn PRF result.')
  }
  return bytesToHex(result)
}

export function isPasskeyPrfAvailable() {
  return Boolean(window.PublicKeyCredential && navigator.credentials && window.crypto?.subtle)
}

export async function createPasskeyPrfKey(walletName: string): Promise<PasskeyPrfRegistration> {
  if (!isPasskeyPrfAvailable()) {
    throw new Error('WebAuthn PRF is not available in this webview.')
  }
  const rpId = getRpId()
  const salt = randomBytes(32)
  const userId = randomBytes(32)
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(32),
      rp: {
        name: 'MyKey',
        ...(rpId ? { id: rpId } : {}),
      },
      user: {
        id: userId,
        name: walletName || 'mykey-wallet',
        displayName: walletName || 'MyKey Wallet',
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
      extensions: {
        prf: {
          eval: { first: salt },
        },
      },
    },
  } as CredentialCreationOptions)) as PublicKeyCredential | null

  if (!credential) {
    throw new Error('Passkey creation was cancelled.')
  }

  const credentialId = bytesToBase64Url(new Uint8Array(credential.rawId))
  let prfKeyHex = ''
  try {
    prfKeyHex = prfResultToHex(credential)
  } catch {
    prfKeyHex = await getPasskeyPrfKey(credentialId, bytesToBase64Url(salt), rpId)
  }

  return {
    credentialId,
    rpId: rpId || '',
    prfSalt: bytesToBase64Url(salt),
    prfKeyHex,
  }
}

export async function getPasskeyPrfKey(
  credentialId: string,
  prfSalt: string,
  rpId?: string | null
) {
  if (!isPasskeyPrfAvailable()) {
    throw new Error('WebAuthn PRF is not available in this webview.')
  }
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      ...(rpId ? { rpId } : {}),
      allowCredentials: [
        {
          type: 'public-key',
          id: base64UrlToBytes(credentialId),
        },
      ],
      userVerification: 'required',
      extensions: {
        prf: {
          eval: {
            first: base64UrlToBytes(prfSalt),
          },
        },
      },
    },
  } as CredentialRequestOptions)) as PublicKeyCredential | null

  if (!credential) {
    throw new Error('Passkey unlock was cancelled.')
  }
  return prfResultToHex(credential)
}
