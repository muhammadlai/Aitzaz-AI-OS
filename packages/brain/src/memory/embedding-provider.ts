import { invalidArgument } from '../errors/index.js';
import type { Vector } from '../types/index.js';
import { hashEmbedding } from '../utils/index.js';
import type { EmbeddingProvider } from './vector-memory.js';

/**
 * Deterministic hashing embedder. It requires no network access, which keeps
 * the brain layer runnable in browsers, Workers, CI, and offline development.
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  public constructor(public readonly dimensions: number = 128) {
    if (!Number.isInteger(dimensions) || dimensions < 8) {
      throw invalidArgument('Embedding dimensions must be an integer of at least 8');
    }
  }

  public async embed(text: string): Promise<Vector> {
    return hashEmbedding(text, this.dimensions);
  }

  public async embedMany(texts: readonly string[]): Promise<readonly Vector[]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }
}

/** Caches embeddings by exact text so repeated content is embedded once. */
export class CachingEmbeddingProvider implements EmbeddingProvider {
  private readonly cache = new Map<string, Vector>();

  public constructor(
    private readonly inner: EmbeddingProvider,
    private readonly capacity = 1_000
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw invalidArgument('Embedding cache capacity must be a positive integer');
    }
  }

  public get dimensions(): number {
    return this.inner.dimensions;
  }

  public async embed(text: string): Promise<Vector> {
    const cached = this.cache.get(text);
    if (cached !== undefined) return cached;
    const vector = await this.inner.embed(text);
    if (this.cache.size >= this.capacity) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(text, vector);
    return vector;
  }

  public async embedMany(texts: readonly string[]): Promise<readonly Vector[]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }
}
