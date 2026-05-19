import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { GatewayError } from '../errors.js'

export interface EncryptedSecret {
  ciphertext: string
  nonce: string
  keyVersion: string
}

function getKey(masterKeys: Record<string, Uint8Array>, keyVersion: string): Buffer {
  const key = masterKeys[keyVersion]
  if (!key) throw new GatewayError('master_key_not_found', 500)
  if (key.byteLength !== 32) throw new GatewayError('invalid_master_key_length', 500)
  return Buffer.from(key)
}

export async function envelopeEncrypt(input: {
  plaintext: string
  masterKeys: Record<string, Uint8Array>
  keyVersion: string
}): Promise<EncryptedSecret> {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', getKey(input.masterKeys, input.keyVersion), nonce)
  const encrypted = Buffer.concat([cipher.update(input.plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    ciphertext: Buffer.concat([encrypted, tag]).toString('base64url'),
    nonce: nonce.toString('base64url'),
    keyVersion: input.keyVersion,
  }
}

export async function envelopeDecrypt(input: {
  encrypted: EncryptedSecret
  masterKeys: Record<string, Uint8Array>
}): Promise<string> {
  const payload = Buffer.from(input.encrypted.ciphertext, 'base64url')
  const encrypted = payload.subarray(0, payload.length - 16)
  const tag = payload.subarray(payload.length - 16)
  const decipher = createDecipheriv(
    'aes-256-gcm',
    getKey(input.masterKeys, input.encrypted.keyVersion),
    Buffer.from(input.encrypted.nonce, 'base64url')
  )
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}
