import { NexusError } from '../errors/index.js';
import type { MaybePromise, Page, PaginationCursor } from '../types/index.js';
import { AsyncMutex, deepClone } from '../utils/index.js';

export interface StoredEntry<T> { readonly key: string; readonly value: T; readonly version: number; readonly updatedAt: string; }
export interface StorageTransaction {
  get<T>(key: string): Promise<StoredEntry<T> | undefined>;
  set<T>(key: string, value: T, expectedVersion?: number): Promise<StoredEntry<T>>;
  delete(key: string, expectedVersion?: number): Promise<boolean>;
}
export interface KeyValueStore extends StorageTransaction {
  list<T>(prefix?: string, page?: PaginationCursor): Promise<Page<StoredEntry<T>>>;
  transaction<T>(operation: (transaction: StorageTransaction) => MaybePromise<T>): Promise<T>;
}

interface InternalEntry { readonly value: unknown; readonly version: number; readonly updatedAt: string; }

/** In-memory implementation with serialized, optimistic-version transactions for local and edge-safe runtimes. */
export class MemoryKeyValueStore implements KeyValueStore {
  private readonly values = new Map<string, InternalEntry>();
  private readonly mutex = new AsyncMutex();

  public async get<T>(key: string): Promise<StoredEntry<T> | undefined> { return this.toStored<T>(key, this.values.get(this.validKey(key))); }
  public async set<T>(key: string, value: T, expectedVersion?: number): Promise<StoredEntry<T>> { return await this.mutex.runExclusive(() => this.write(key, value, expectedVersion)); }
  public async delete(key: string, expectedVersion?: number): Promise<boolean> { return await this.mutex.runExclusive(() => this.remove(key, expectedVersion)); }

  public async list<T>(prefix = '', page: PaginationCursor = {}): Promise<Page<StoredEntry<T>>> {
    const limit = page.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new NexusError('INVALID_ARGUMENT', 'Page limit must be an integer between 1 and 1000');
    const keys = [...this.values.keys()].filter((key) => key.startsWith(prefix)).sort();
    const cursor = page.cursor;
    const start = cursor === undefined ? 0 : Math.max(0, keys.findIndex((key) => key > cursor));
    const selected = keys.slice(start, start + limit);
    const finalKey = selected.at(-1);
    return { items: selected.flatMap((key) => { const entry = this.toStored<T>(key, this.values.get(key)); return entry === undefined ? [] : [entry]; }), ...(finalKey === undefined || start + limit >= keys.length ? {} : { nextCursor: finalKey }) };
  }

  public async transaction<T>(operation: (transaction: StorageTransaction) => MaybePromise<T>): Promise<T> {
    return await this.mutex.runExclusive(async () => await operation({ get: this.get.bind(this), set: this.write.bind(this), delete: this.remove.bind(this) }));
  }

  private async write<T>(key: string, value: T, expectedVersion?: number): Promise<StoredEntry<T>> {
    const validKey = this.validKey(key);
    const current = this.values.get(validKey);
    if (expectedVersion !== undefined && current?.version !== expectedVersion) throw new NexusError('CONFLICT', `Storage version conflict for key "${validKey}"`);
    if (expectedVersion !== undefined && current === undefined) throw new NexusError('CONFLICT', `Storage key "${validKey}" does not exist`);
    const entry: InternalEntry = { value: deepClone(value), version: (current?.version ?? 0) + 1, updatedAt: new Date().toISOString() };
    this.values.set(validKey, entry);
    return this.toStored<T>(validKey, entry) as StoredEntry<T>;
  }

  private async remove(key: string, expectedVersion?: number): Promise<boolean> {
    const validKey = this.validKey(key);
    const current = this.values.get(validKey);
    if (current === undefined) return false;
    if (expectedVersion !== undefined && current.version !== expectedVersion) throw new NexusError('CONFLICT', `Storage version conflict for key "${validKey}"`);
    this.values.delete(validKey);
    return true;
  }

  private toStored<T>(key: string, entry: InternalEntry | undefined): StoredEntry<T> | undefined {
    return entry === undefined ? undefined : Object.freeze({ key, value: deepClone(entry.value) as T, version: entry.version, updatedAt: entry.updatedAt });
  }
  private validKey(key: string): string { if (key.trim() === '' || key.length > 1_024) throw new NexusError('INVALID_ARGUMENT', 'Storage key must be between 1 and 1024 characters'); return key; }
}

export class ScopedKeyValueStore implements KeyValueStore {
  public constructor(private readonly store: KeyValueStore, private readonly scope: string) {
    if (scope.trim() === '') throw new NexusError('INVALID_ARGUMENT', 'Storage scope must not be empty');
  }
  public async get<T>(key: string): Promise<StoredEntry<T> | undefined> { return this.unscoped(await this.store.get<T>(this.key(key))); }
  public async set<T>(key: string, value: T, expectedVersion?: number): Promise<StoredEntry<T>> { return this.unscoped(await this.store.set(this.key(key), value, expectedVersion)) as StoredEntry<T>; }
  public delete(key: string, expectedVersion?: number): Promise<boolean> { return this.store.delete(this.key(key), expectedVersion); }
  public async list<T>(prefix = '', page?: PaginationCursor): Promise<Page<StoredEntry<T>>> {
    const scopedPage = page === undefined ? undefined : { ...page, ...(page.cursor === undefined ? {} : { cursor: this.key(page.cursor) }) };
    const result = await this.store.list<T>(this.key(prefix), scopedPage);
    return { items: result.items.map((entry) => this.unscoped(entry) as StoredEntry<T>), ...(result.nextCursor === undefined ? {} : { nextCursor: this.unscopedKey(result.nextCursor) }) };
  }
  public transaction<T>(operation: (transaction: StorageTransaction) => MaybePromise<T>): Promise<T> {
    return this.store.transaction((transaction) => operation({
      get: async <V>(key: string) => this.unscoped(await transaction.get<V>(this.key(key))),
      set: async <V>(key: string, value: V, version?: number) => this.unscoped(await transaction.set(this.key(key), value, version)) as StoredEntry<V>,
      delete: (key, version) => transaction.delete(this.key(key), version)
    }));
  }
  private key(key: string): string { return `${this.scope}:${key}`; }
  private unscoped<T>(entry: StoredEntry<T> | undefined): StoredEntry<T> | undefined {
    return entry === undefined ? undefined : Object.freeze({ ...entry, key: this.unscopedKey(entry.key) });
  }
  private unscopedKey(key: string): string { return key.slice(this.scope.length + 1); }
}
