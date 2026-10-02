import crypto from 'crypto'

/**
 * At-rest encryption for the Medusa secret API key.
 *
 * AES-256-GCM with a dedicated env key, mirroring the WooCommerce/Shopify
 * credential stores (extensions/general/woocommerce/lib/credentials.ts):
 * 12-byte IV, 16-byte auth tag, layout iv|tag|ciphertext, base64url encoded.
 * The key is deployment-wide (not per-tenant); what makes rows useless
 * off-server is that MEDUSA_CREDENTIALS_ENCRYPTION_KEY never leaves the
 * environment.
 */

const ALGORITHM = 'aes-256-gcm'

/** Whether the integration is configured on this deployment. */
export function isMedusaConfigured(): boolean {
  return Boolean(process.env.MEDUSA_CREDENTIALS_ENCRYPTION_KEY)
}

function getEncryptionKey(): Buffer {
  const key = process.env.MEDUSA_CREDENTIALS_ENCRYPTION_KEY
  if (!key) throw new Error('MEDUSA_CREDENTIALS_ENCRYPTION_KEY is required')
  return crypto.createHash('sha256').update(key).digest()
}

export function encryptCredential(plaintext: string): string {
  const key = getEncryptionKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64url')
}

export function decryptCredential(ciphertext: string): string {
  const key = getEncryptionKey()
  const combined = Buffer.from(ciphertext, 'base64url')
  const iv = combined.subarray(0, 12)
  const tag = combined.subarray(12, 28)
  const encrypted = combined.subarray(28)
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

export interface MedusaCredentials {
  storeUrl: string
  adminApiKey: string
}

/** Decrypted API credentials for an active connection. */
export function credentialsOf(connection: {
  store_url: string
  admin_api_key_encrypted: string | null
}): MedusaCredentials {
  if (!connection.admin_api_key_encrypted) {
    throw new Error('Connection has no stored credentials')
  }
  return {
    storeUrl: connection.store_url,
    adminApiKey: decryptCredential(connection.admin_api_key_encrypted),
  }
}
