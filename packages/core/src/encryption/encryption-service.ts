import { NexusError } from '../errors/index.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};
const ownedBytes = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(bytes);
const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new NexusError('ENCRYPTION_FAILED', 'Encrypted payload is malformed');
  try { return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), (character) => character.charCodeAt(0)); }
  catch { throw new NexusError('ENCRYPTION_FAILED', 'Encrypted payload cannot be decoded'); }
};

export interface EncryptedPayload { readonly version: 1; readonly iv: string; readonly ciphertext: string; }

/** AES-GCM encryption backed by the Web Crypto API, compatible with Node, browsers, and Cloudflare Workers. */
export class EncryptionService {
  private constructor(private readonly key: CryptoKey) {}

  public static async fromSecret(secret: string): Promise<EncryptionService> {
    if (secret.length < 16) throw new NexusError('CONFIGURATION_INVALID', 'Encryption secret must be at least 16 characters');
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
    const key = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    return new EncryptionService(key);
  }

  public async encrypt(plaintext: string, associatedData?: string): Promise<EncryptedPayload> {
    try {
      const iv = ownedBytes(crypto.getRandomValues(new Uint8Array(12)));
      const params: AesGcmParams = { name: 'AES-GCM', iv, ...(associatedData === undefined ? {} : { additionalData: encoder.encode(associatedData) }) };
      const encrypted = await crypto.subtle.encrypt(params, this.key, encoder.encode(plaintext));
      return Object.freeze({ version: 1, iv: toBase64Url(iv), ciphertext: toBase64Url(new Uint8Array(encrypted)) });
    } catch (error) { throw new NexusError('ENCRYPTION_FAILED', 'Unable to encrypt payload', { cause: error }); }
  }

  public async decrypt(payload: EncryptedPayload, associatedData?: string): Promise<string> {
    if (payload.version !== 1) throw new NexusError('ENCRYPTION_FAILED', 'Encrypted payload version is unsupported');
    try {
      const params: AesGcmParams = { name: 'AES-GCM', iv: ownedBytes(fromBase64Url(payload.iv)), ...(associatedData === undefined ? {} : { additionalData: encoder.encode(associatedData) }) };
      const decrypted = await crypto.subtle.decrypt(params, this.key, ownedBytes(fromBase64Url(payload.ciphertext)));
      return decoder.decode(decrypted);
    } catch (error) { throw new NexusError('ENCRYPTION_FAILED', 'Unable to decrypt payload', { cause: error }); }
  }
}
