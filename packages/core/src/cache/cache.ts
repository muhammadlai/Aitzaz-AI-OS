import { DEFAULT_CACHE_TTL_MS } from '../constants/index.js';
import { NexusError } from '../errors/index.js';
import { deepClone } from '../utils/index.js';

export interface CacheEntry<T> { readonly value: T; readonly expiresAt: number; }
export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  clear(prefix?: string): Promise<number>;
  getOrSet<T>(key: string, factory: () => Promise<T>, ttlMs?: number): Promise<T>;
}

export class MemoryCache implements Cache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly pending = new Map<string, Promise<unknown>>();
  public constructor(private readonly defaultTtlMs = DEFAULT_CACHE_TTL_MS) {}

  public async get<T>(key: string): Promise<T | undefined> {
    const entry = this.entries.get(this.validKey(key));
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) { this.entries.delete(key); return undefined; }
    return deepClone(entry.value) as T;
  }
  public async set<T>(key: string, value: T, ttlMs = this.defaultTtlMs): Promise<void> {
    this.assertTtl(ttlMs); this.entries.set(this.validKey(key), { value: deepClone(value), expiresAt: Date.now() + ttlMs });
  }
  public async delete(key: string): Promise<boolean> { return this.entries.delete(this.validKey(key)); }
  public async clear(prefix = ''): Promise<number> { let removed = 0; for (const key of this.entries.keys()) if (key.startsWith(prefix)) { this.entries.delete(key); removed += 1; } return removed; }
  public async getOrSet<T>(key: string, factory: () => Promise<T>, ttlMs = this.defaultTtlMs): Promise<T> {
    const cached = await this.get<T>(key); if (cached !== undefined) return cached;
    const existing = this.pending.get(key) as Promise<T> | undefined;
    if (existing !== undefined) return await existing;
    const pending = factory().then(async (value) => { await this.set(key, value, ttlMs); return value; });
    this.pending.set(key, pending);
    try { return await pending; } finally { this.pending.delete(key); }
  }
  private validKey(key: string): string { if (key.trim() === '') throw new NexusError('INVALID_ARGUMENT', 'Cache key must not be empty'); return key; }
  private assertTtl(ttlMs: number): void { if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new NexusError('INVALID_ARGUMENT', 'Cache TTL must be a positive finite number'); }
}
