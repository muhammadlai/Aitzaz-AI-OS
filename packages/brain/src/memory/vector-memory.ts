import type { JsonObject } from '@nexus/core';
import { invalidArgument, notFound } from '../errors/index.js';
import type { ScoredResult, SimilarityMetric, Vector } from '../types/index.js';
import { similarity } from '../utils/index.js';

/** A vector paired with the payload it represents. */
export interface VectorEntry {
  readonly id: string;
  readonly vector: Vector;
  readonly namespace: string;
  readonly metadata: JsonObject;
}

/** Query issued against a vector index. */
export interface VectorQuery {
  readonly vector: Vector;
  readonly namespace?: string;
  readonly topK?: number;
  readonly minScore?: number;
  readonly filter?: (entry: VectorEntry) => boolean;
}

/**
 * Storage-agnostic vector index contract. Implementations may be backed by
 * memory, a database, or an external vector service.
 */
export interface VectorMemory {
  upsert(entry: VectorEntry): Promise<void>;
  upsertMany(entries: readonly VectorEntry[]): Promise<void>;
  get(id: string): Promise<VectorEntry | undefined>;
  delete(id: string): Promise<boolean>;
  search(query: VectorQuery): Promise<readonly ScoredResult<VectorEntry>[]>;
  size(namespace?: string): Promise<number>;
  clear(namespace?: string): Promise<number>;
}

/** Converts text into an embedding vector. */
export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(text: string): Promise<Vector>;
  embedMany(texts: readonly string[]): Promise<readonly Vector[]>;
}

/**
 * Exhaustive-search vector index. Correctness and predictability are chosen
 * over approximate recall, which suits the volumes an OS control plane holds.
 */
export class InMemoryVectorMemory implements VectorMemory {
  private readonly entries = new Map<string, VectorEntry>();

  public constructor(private readonly metric: SimilarityMetric = 'cosine') {}

  public async upsert(entry: VectorEntry): Promise<void> {
    if (entry.id.trim() === '') throw invalidArgument('Vector entry id must not be empty');
    if (entry.vector.length === 0) throw invalidArgument('Vector entry must have at least one dimension');
    if (entry.vector.some((component) => !Number.isFinite(component))) {
      throw invalidArgument('Vector components must all be finite numbers');
    }
    const existing = [...this.entries.values()][0];
    if (existing !== undefined && existing.vector.length !== entry.vector.length) {
      throw invalidArgument(
        `Vector dimension mismatch: index holds ${existing.vector.length}-dimension vectors, received ${entry.vector.length}`
      );
    }
    this.entries.set(entry.id, { ...entry, vector: [...entry.vector] });
  }

  public async upsertMany(entries: readonly VectorEntry[]): Promise<void> {
    for (const entry of entries) await this.upsert(entry);
  }

  public async get(id: string): Promise<VectorEntry | undefined> {
    return this.entries.get(id);
  }

  public async require(id: string): Promise<VectorEntry> {
    const entry = this.entries.get(id);
    if (entry === undefined) throw notFound('Vector entry', id);
    return entry;
  }

  public async delete(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }

  public async search(query: VectorQuery): Promise<readonly ScoredResult<VectorEntry>[]> {
    const topK = query.topK ?? 10;
    if (!Number.isInteger(topK) || topK < 1) throw invalidArgument('topK must be a positive integer');

    const candidates = [...this.entries.values()].filter((entry) => {
      if (query.namespace !== undefined && entry.namespace !== query.namespace) return false;
      if (entry.vector.length !== query.vector.length) return false;
      return query.filter === undefined || query.filter(entry);
    });

    const scored = candidates.map((entry) => ({ item: entry, score: similarity(query.vector, entry.vector, this.metric) }));
    const filtered = query.minScore === undefined ? scored : scored.filter((result) => result.score >= (query.minScore as number));

    // Ties resolve on id so results are stable across identical queries.
    return filtered
      .sort((left, right) => (right.score === left.score ? left.item.id.localeCompare(right.item.id) : right.score - left.score))
      .slice(0, topK);
  }

  public async size(namespace?: string): Promise<number> {
    if (namespace === undefined) return this.entries.size;
    return [...this.entries.values()].filter((entry) => entry.namespace === namespace).length;
  }

  public async clear(namespace?: string): Promise<number> {
    if (namespace === undefined) {
      const removed = this.entries.size;
      this.entries.clear();
      return removed;
    }
    let removed = 0;
    for (const [id, entry] of [...this.entries.entries()]) {
      if (entry.namespace === namespace) {
        this.entries.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}
