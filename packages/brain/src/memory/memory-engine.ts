import { createId, type KeyValueStore } from '@nexus/core';
import { invalidArgument, notFound } from '../errors/index.js';
import { SystemClock, type Clock } from '../types/index.js';
import type { MemoryInput, MemoryKind, MemoryQuery, MemoryRecord, MemoryStatistics } from './memory-types.js';
import type { EmbeddingProvider, VectorMemory } from './vector-memory.js';

const MEMORY_KINDS: readonly MemoryKind[] = ['episodic', 'semantic', 'procedural', 'working'];
const INDEX_KEY = '__index__';

export interface MemoryEngineOptions {
  readonly store: KeyValueStore;
  readonly clock?: Clock;
  readonly vectors?: VectorMemory;
  readonly embeddings?: EmbeddingProvider;
  /** Maximum records retained per namespace before consolidation prunes. */
  readonly capacityPerNamespace?: number;
}

const tokenize = (text: string): readonly string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/**
 * Durable memory store for the brain layer.
 *
 * Records persist through the Phase 1 `KeyValueStore`, so any backend that
 * satisfies that contract (memory, edge KV, database) works unchanged. When a
 * vector index and embedding provider are supplied the engine additionally
 * maintains semantic recall.
 */
export class PersistentMemoryEngine {
  private readonly store: KeyValueStore;
  private readonly clock: Clock;
  private readonly vectors: VectorMemory | undefined;
  private readonly embeddings: EmbeddingProvider | undefined;
  private readonly capacityPerNamespace: number;

  public constructor(options: MemoryEngineOptions) {
    this.store = options.store;
    this.clock = options.clock ?? new SystemClock();
    this.vectors = options.vectors;
    this.embeddings = options.embeddings;
    this.capacityPerNamespace = options.capacityPerNamespace ?? 10_000;
    if (!Number.isInteger(this.capacityPerNamespace) || this.capacityPerNamespace < 1) {
      throw invalidArgument('capacityPerNamespace must be a positive integer');
    }
  }

  /** Persists a memory and indexes it for semantic recall when embeddings are configured. */
  public async remember(input: MemoryInput): Promise<MemoryRecord> {
    const namespace = this.validNamespace(input.namespace);
    if (input.content.trim() === '') throw invalidArgument('Memory content must not be empty');
    const importance = input.importance ?? 0.5;
    if (!Number.isFinite(importance) || importance < 0 || importance > 1) {
      throw invalidArgument('Memory importance must be between 0 and 1');
    }
    if (input.ttlMs !== undefined && (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0)) {
      throw invalidArgument('Memory ttlMs must be a positive number');
    }

    const now = this.clock.timestamp();
    const id = input.id ?? createId('mem');
    const embedding = input.embedding ?? (this.embeddings === undefined ? undefined : await this.embeddings.embed(input.content));

    const record: MemoryRecord = {
      id,
      namespace,
      kind: input.kind,
      content: input.content,
      importance,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      ...(input.ttlMs === undefined ? {} : { expiresAt: new Date(this.clock.now() + input.ttlMs).toISOString() }),
      tags: Object.freeze([...new Set(input.tags ?? [])]),
      ...(embedding === undefined ? {} : { embedding: [...embedding] }),
      metadata: input.metadata ?? {}
    };

    await this.store.set(this.recordKey(namespace, id), record);
    await this.addToIndex(namespace, id);

    if (this.vectors !== undefined && embedding !== undefined) {
      await this.vectors.upsert({ id, vector: embedding, namespace, metadata: { kind: record.kind, content: record.content } });
    }

    await this.enforceCapacity(namespace);
    return record;
  }

  /** Reads a memory and records the access for recency-weighted recall. */
  public async recall(namespace: string, id: string): Promise<MemoryRecord | undefined> {
    const entry = await this.store.get<MemoryRecord>(this.recordKey(this.validNamespace(namespace), id));
    if (entry === undefined) return undefined;
    if (this.isExpired(entry.value)) {
      await this.forget(namespace, id);
      return undefined;
    }
    const touched: MemoryRecord = {
      ...entry.value,
      lastAccessedAt: this.clock.timestamp(),
      accessCount: entry.value.accessCount + 1
    };
    await this.store.set(this.recordKey(namespace, id), touched);
    return touched;
  }

  /** Reads a memory or throws when it is absent. */
  public async require(namespace: string, id: string): Promise<MemoryRecord> {
    const record = await this.recall(namespace, id);
    if (record === undefined) throw notFound('Memory', id);
    return record;
  }

  /** Applies a partial update while preserving identity and creation time. */
  public async update(
    namespace: string,
    id: string,
    changes: Partial<Pick<MemoryRecord, 'content' | 'importance' | 'tags' | 'metadata'>>
  ): Promise<MemoryRecord> {
    const current = await this.require(namespace, id);
    if (changes.importance !== undefined && (changes.importance < 0 || changes.importance > 1)) {
      throw invalidArgument('Memory importance must be between 0 and 1');
    }
    const content = changes.content ?? current.content;
    const embedding =
      changes.content !== undefined && this.embeddings !== undefined ? await this.embeddings.embed(content) : current.embedding;

    const updated: MemoryRecord = {
      ...current,
      content,
      importance: changes.importance ?? current.importance,
      tags: changes.tags === undefined ? current.tags : Object.freeze([...new Set(changes.tags)]),
      metadata: changes.metadata ?? current.metadata,
      ...(embedding === undefined ? {} : { embedding: [...embedding] }),
      updatedAt: this.clock.timestamp()
    };

    await this.store.set(this.recordKey(namespace, id), updated);
    if (this.vectors !== undefined && embedding !== undefined) {
      await this.vectors.upsert({ id, vector: embedding, namespace, metadata: { kind: updated.kind, content: updated.content } });
    }
    return updated;
  }

  /** Permanently removes a memory from both the record store and vector index. */
  public async forget(namespace: string, id: string): Promise<boolean> {
    const removed = await this.store.delete(this.recordKey(this.validNamespace(namespace), id));
    await this.removeFromIndex(namespace, id);
    if (this.vectors !== undefined) await this.vectors.delete(id);
    return removed;
  }

  /** Lists memories matching a structured filter, ranked by relevance then recency. */
  public async search(query: MemoryQuery): Promise<readonly MemoryRecord[]> {
    const namespace = this.validNamespace(query.namespace);
    const limit = query.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1) throw invalidArgument('Memory query limit must be a positive integer');

    const records = await this.loadNamespace(namespace, query.includeExpired ?? false);
    const queryTokens = query.text === undefined ? [] : tokenize(query.text);

    const matching = records.filter((record) => {
      if (query.kinds !== undefined && !query.kinds.includes(record.kind)) return false;
      if (query.minImportance !== undefined && record.importance < query.minImportance) return false;
      if (query.tags !== undefined && !query.tags.every((tag) => record.tags.includes(tag))) return false;
      if (queryTokens.length > 0) {
        const contentTokens = new Set(tokenize(record.content));
        if (!queryTokens.some((token) => contentTokens.has(token))) return false;
      }
      return true;
    });

    return matching
      .map((record) => ({ record, score: this.lexicalScore(record, queryTokens) }))
      .sort((left, right) =>
        right.score === left.score ? right.record.createdAt.localeCompare(left.record.createdAt) : right.score - left.score
      )
      .slice(0, limit)
      .map((entry) => entry.record);
  }

  /** Semantic recall through the configured vector index. */
  public async semanticSearch(namespace: string, text: string, topK = 5): Promise<readonly MemoryRecord[]> {
    if (this.vectors === undefined || this.embeddings === undefined) {
      throw invalidArgument('Semantic search requires both a vector index and an embedding provider');
    }
    const vector = await this.embeddings.embed(text);
    const hits = await this.vectors.search({ vector, namespace: this.validNamespace(namespace), topK });
    const records: MemoryRecord[] = [];
    for (const hit of hits) {
      const record = await this.recall(namespace, hit.item.id);
      if (record !== undefined) records.push(record);
    }
    return records;
  }

  /** Removes expired memories and prunes the least valuable records above capacity. */
  public async consolidate(namespace: string): Promise<number> {
    const validated = this.validNamespace(namespace);
    const all = await this.loadNamespace(validated, true);
    let removed = 0;
    for (const record of all) {
      if (this.isExpired(record)) {
        await this.forget(validated, record.id);
        removed += 1;
      }
    }
    removed += await this.enforceCapacity(validated);
    return removed;
  }

  /** Aggregate statistics describing a namespace. */
  public async statistics(namespace: string): Promise<MemoryStatistics> {
    const validated = this.validNamespace(namespace);
    const records = await this.loadNamespace(validated, false);
    const byKind = Object.fromEntries(
      MEMORY_KINDS.map((kind) => [kind, records.filter((record) => record.kind === kind).length])
    ) as Record<MemoryKind, number>;
    const created = records.map((record) => record.createdAt).sort();
    const total = records.length;
    return Object.freeze({
      namespace: validated,
      total,
      byKind: Object.freeze(byKind),
      averageImportance: total === 0 ? 0 : records.reduce((sum, record) => sum + record.importance, 0) / total,
      ...(created[0] === undefined ? {} : { oldestCreatedAt: created[0] }),
      ...(created.at(-1) === undefined ? {} : { newestCreatedAt: created.at(-1) as string })
    });
  }

  /** Deletes every memory in a namespace. */
  public async clear(namespace: string): Promise<number> {
    const validated = this.validNamespace(namespace);
    const ids = await this.readIndex(validated);
    for (const id of ids) {
      await this.store.delete(this.recordKey(validated, id));
      if (this.vectors !== undefined) await this.vectors.delete(id);
    }
    await this.store.delete(this.indexKey(validated));
    return ids.length;
  }

  private lexicalScore(record: MemoryRecord, queryTokens: readonly string[]): number {
    const recencyMs = Math.max(0, this.clock.now() - Date.parse(record.createdAt));
    const recency = 1 / (1 + recencyMs / 86_400_000);
    if (queryTokens.length === 0) return record.importance * 0.7 + recency * 0.3;
    const contentTokens = tokenize(record.content);
    const contentSet = new Set(contentTokens);
    const overlap = queryTokens.filter((token) => contentSet.has(token)).length / queryTokens.length;
    return overlap * 0.6 + record.importance * 0.25 + recency * 0.15;
  }

  private isExpired(record: MemoryRecord): boolean {
    return record.expiresAt !== undefined && Date.parse(record.expiresAt) <= this.clock.now();
  }

  private async enforceCapacity(namespace: string): Promise<number> {
    const ids = await this.readIndex(namespace);
    if (ids.length <= this.capacityPerNamespace) return 0;
    const records = await this.loadNamespace(namespace, true);
    // Least important, least recently accessed records are pruned first.
    const ordered = [...records].sort((left, right) =>
      left.importance === right.importance
        ? left.lastAccessedAt.localeCompare(right.lastAccessedAt)
        : left.importance - right.importance
    );
    const excess = ordered.slice(0, records.length - this.capacityPerNamespace);
    for (const record of excess) await this.forget(namespace, record.id);
    return excess.length;
  }

  private async loadNamespace(namespace: string, includeExpired: boolean): Promise<readonly MemoryRecord[]> {
    const ids = await this.readIndex(namespace);
    const records: MemoryRecord[] = [];
    for (const id of ids) {
      const entry = await this.store.get<MemoryRecord>(this.recordKey(namespace, id));
      if (entry === undefined) continue;
      if (!includeExpired && this.isExpired(entry.value)) continue;
      records.push(entry.value);
    }
    return records;
  }

  private async readIndex(namespace: string): Promise<readonly string[]> {
    const entry = await this.store.get<readonly string[]>(this.indexKey(namespace));
    return entry?.value ?? [];
  }

  private async addToIndex(namespace: string, id: string): Promise<void> {
    const ids = await this.readIndex(namespace);
    if (ids.includes(id)) return;
    await this.store.set(this.indexKey(namespace), [...ids, id]);
  }

  private async removeFromIndex(namespace: string, id: string): Promise<void> {
    const ids = await this.readIndex(namespace);
    if (!ids.includes(id)) return;
    await this.store.set(
      this.indexKey(namespace),
      ids.filter((candidate) => candidate !== id)
    );
  }

  private recordKey(namespace: string, id: string): string {
    return `memory:${namespace}:record:${id}`;
  }

  private indexKey(namespace: string): string {
    return `memory:${namespace}:${INDEX_KEY}`;
  }

  private validNamespace(namespace: string): string {
    if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/.test(namespace)) {
      throw invalidArgument(`Invalid memory namespace "${namespace}"`);
    }
    return namespace;
  }
}
