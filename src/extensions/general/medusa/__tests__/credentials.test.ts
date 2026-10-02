import { describe, it, expect, beforeEach } from 'vitest'
import { encryptCredential, decryptCredential, isMedusaConfigured } from '../lib/credentials'
import { normalizeStoreUrl } from '../lib/api-client'

describe('credential codec', () => {
  beforeEach(() => {
    process.env.MEDUSA_CREDENTIALS_ENCRYPTION_KEY = 'test-key'
  })

  it('round-trips a secret API key', () => {
    const ciphertext = encryptCredential('sk_1234567890abcdef')
    expect(ciphertext).not.toContain('sk_1234567890abcdef')
    expect(decryptCredential(ciphertext)).toBe('sk_1234567890abcdef')
  })

  it('produces a fresh IV per encryption (no ciphertext reuse)', () => {
    expect(encryptCredential('sk_secret')).not.toBe(encryptCredential('sk_secret'))
  })

  it('rejects tampered ciphertext (GCM auth tag)', () => {
    const ciphertext = encryptCredential('sk_secret')
    const tampered = ciphertext.slice(0, -2) + (ciphertext.endsWith('AA') ? 'BB' : 'AA')
    expect(() => decryptCredential(tampered)).toThrow()
  })

  it('requires the env key', () => {
    delete process.env.MEDUSA_CREDENTIALS_ENCRYPTION_KEY
    expect(isMedusaConfigured()).toBe(false)
    expect(() => encryptCredential('x')).toThrow(/MEDUSA_CREDENTIALS_ENCRYPTION_KEY/)
  })
})

describe('normalizeStoreUrl', () => {
  it('normalizes bare domains, case, and trailing slashes', () => {
    expect(normalizeStoreUrl('Backend.Example.se')).toBe('https://backend.example.se')
    expect(normalizeStoreUrl('https://Backend.Example.se/')).toBe('https://backend.example.se')
    expect(normalizeStoreUrl('  https://backend.example.se  ')).toBe('https://backend.example.se')
  })

  it('refuses private and internal hosts (SSRF guard)', () => {
    expect(normalizeStoreUrl('https://localhost')).toBeNull()
    expect(normalizeStoreUrl('https://foo.localhost')).toBeNull()
    expect(normalizeStoreUrl('https://intranet.local')).toBeNull()
    expect(normalizeStoreUrl('https://db.internal')).toBeNull()
    expect(normalizeStoreUrl('https://127.0.0.1')).toBeNull()
    expect(normalizeStoreUrl('https://10.0.0.5')).toBeNull()
    expect(normalizeStoreUrl('https://172.20.1.1')).toBeNull()
    expect(normalizeStoreUrl('https://192.168.1.10')).toBeNull()
    expect(normalizeStoreUrl('https://169.254.169.254')).toBeNull()
    expect(normalizeStoreUrl('https://[::1]')).toBeNull()
  })

  it('refuses http, credentials, queries and garbage', () => {
    expect(normalizeStoreUrl('http://insecure.se')).toBeNull()
    expect(normalizeStoreUrl('https://user:pass@backend.se')).toBeNull()
    expect(normalizeStoreUrl('https://backend.se/?a=1')).toBeNull()
    expect(normalizeStoreUrl('https://backend.se/#frag')).toBeNull()
    expect(normalizeStoreUrl('not a url at all')).toBeNull()
    expect(normalizeStoreUrl('')).toBeNull()
  })
})
