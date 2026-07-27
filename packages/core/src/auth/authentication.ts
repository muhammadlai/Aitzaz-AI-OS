import { NexusError } from '../errors/index.js';
import type { Principal } from '../permissions/index.js';

interface JwtPayload { readonly sub?: unknown; readonly exp?: unknown; readonly nbf?: unknown; readonly iss?: unknown; readonly aud?: unknown; readonly permissions?: unknown; readonly roles?: unknown; readonly attributes?: unknown; }
interface JwtHeader { readonly alg?: unknown; readonly typ?: unknown; }

export interface TokenVerifier { verify(token: string): Promise<Principal>; }

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const base64UrlToBytes = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new NexusError('AUTHENTICATION_FAILED', 'Token contains invalid base64url data');
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  try { return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0)); }
  catch { throw new NexusError('AUTHENTICATION_FAILED', 'Token contains malformed base64url data'); }
};
const ownedBytes = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(bytes);
const parsePart = <T>(part: string): T => {
  try { return JSON.parse(decoder.decode(base64UrlToBytes(part))) as T; }
  catch (error) { throw new NexusError('AUTHENTICATION_FAILED', 'Token contains malformed JSON', { cause: error }); }
};

/** Verifies RFC 7519 HS256 bearer tokens with the platform Web Crypto implementation. */
export class HmacJwtVerifier implements TokenVerifier {
  private readonly key: Promise<CryptoKey>;
  public constructor(secret: string, private readonly options: { readonly issuer?: string; readonly audience?: string; readonly clockToleranceSeconds?: number } = {}) {
    if (secret.length < 32) throw new NexusError('CONFIGURATION_INVALID', 'JWT HMAC secret must be at least 32 characters');
    this.key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  }

  public async verify(token: string): Promise<Principal> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new NexusError('AUTHENTICATION_FAILED', 'Bearer token must have three JWT segments');
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
    const header = parsePart<JwtHeader>(encodedHeader);
    if (header.alg !== 'HS256' || (header.typ !== undefined && header.typ !== 'JWT')) throw new NexusError('AUTHENTICATION_FAILED', 'Token uses an unsupported signing algorithm');
    const valid = await crypto.subtle.verify('HMAC', await this.key, ownedBytes(base64UrlToBytes(encodedSignature)), encoder.encode(`${encodedHeader}.${encodedPayload}`));
    if (!valid) throw new NexusError('AUTHENTICATION_FAILED', 'Token signature is invalid');
    const claims = parsePart<JwtPayload>(encodedPayload);
    const now = Math.floor(Date.now() / 1_000);
    const tolerance = this.options.clockToleranceSeconds ?? 30;
    if (typeof claims.exp !== 'number' || claims.exp + tolerance < now) throw new NexusError('AUTHENTICATION_FAILED', 'Token has expired');
    if (typeof claims.nbf === 'number' && claims.nbf - tolerance > now) throw new NexusError('AUTHENTICATION_FAILED', 'Token is not active yet');
    if (this.options.issuer !== undefined && claims.iss !== this.options.issuer) throw new NexusError('AUTHENTICATION_FAILED', 'Token issuer is invalid');
    const audience = claims.aud;
    const expectedAudience = this.options.audience;
    const hasAudience = expectedAudience === undefined || (typeof audience === 'string' ? audience === expectedAudience : Array.isArray(audience) && audience.includes(expectedAudience));
    if (expectedAudience !== undefined && !hasAudience) throw new NexusError('AUTHENTICATION_FAILED', 'Token audience is invalid');
    if (typeof claims.sub !== 'string' || claims.sub.trim() === '') throw new NexusError('AUTHENTICATION_FAILED', 'Token subject is missing');
    const stringList = (value: unknown): readonly string[] => Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
    const attributes = typeof claims.attributes === 'object' && claims.attributes !== null
      ? Object.fromEntries(Object.entries(claims.attributes).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};
    return Object.freeze({ id: claims.sub, subject: claims.sub, permissions: Object.freeze([...new Set(stringList(claims.permissions))]), roles: Object.freeze([...new Set(stringList(claims.roles))]), attributes: Object.freeze(attributes) });
  }
}

export class AuthenticationService {
  public constructor(private readonly verifier: TokenVerifier) {}
  public async authenticateHeader(header: string | undefined): Promise<Principal> {
    if (header === undefined || !header.startsWith('Bearer ')) throw new NexusError('AUTHENTICATION_FAILED', 'A bearer authorization header is required');
    const token = header.slice('Bearer '.length).trim();
    if (token === '') throw new NexusError('AUTHENTICATION_FAILED', 'Bearer token is empty');
    return await this.verifier.verify(token);
  }
}
