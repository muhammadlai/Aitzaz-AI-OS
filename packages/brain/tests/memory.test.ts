import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CachingEmbeddingProvider,
  HashEmbeddingProvider,
  InMemoryVectorMemory,
  PersistentMemoryEngine
} from '../src/memory/index.js';
import { cosineSimilarity, hashEmbedding, normalize } from '../src/utils/index.js';
import { clockAt, freshStore } from './helpers.js';

const engine = (): { readonly memory: PersistentMemoryEngine; readonly clock: ReturnType<typeof clockAt> } => {
  const clock = clockAt();
  const memory = new PersistentMemoryEngine({ store: freshStore(), clock });
  return { memory, clock };
};

describe('PersistentMemoryEngine', () => {
  it('stores and recalls a memory', async () => {
    const { memory } = engine();
    const record = await memory.remember({ namespace: 'agent', kind: 'semantic', content: 'Nexus runs on TypeScript' });

    assert.equal(record.namespace, 'agent');
    assert.equal(record.accessCount, 0);

    const recalled = await memory.recall('agent', record.id);
    assert.equal(recalled?.content, 'Nexus runs on TypeScript');
    assert.equal(recalled?.accessCount, 1, 'recall must record the access');
  });

  it('rejects invalid namespaces, empty content, and out-of-range importance', async () => {
    const { memory } = engine();
    await assert.rejects(() => memory.remember({ namespace: '9bad', kind: 'semantic', content: 'x' }), /Invalid memory namespace/);
    await assert.rejects(() => memory.remember({ namespace: 'ok', kind: 'semantic', content: '   ' }), /must not be empty/);
    await assert.rejects(
      () => memory.remember({ namespace: 'ok', kind: 'semantic', content: 'x', importance: 1.5 }),
      /between 0 and 1/
    );
  });

  it('expires memories once their TTL elapses', async () => {
    const { memory, clock } = engine();
    const record = await memory.remember({ namespace: 'temp', kind: 'working', content: 'short lived', ttlMs: 1_000 });

    assert.ok(await memory.recall('temp', record.id));
    clock.advance(1_001);
    assert.equal(await memory.recall('temp', record.id), undefined, 'expired memory must not be returned');
  });

  it('filters search results by kind, tag, and importance', async () => {
    const { memory } = engine();
    await memory.remember({ namespace: 'kb', kind: 'semantic', content: 'alpha protocol', tags: ['x'], importance: 0.9 });
    await memory.remember({ namespace: 'kb', kind: 'episodic', content: 'beta meeting', tags: ['y'], importance: 0.2 });

    assert.equal((await memory.search({ namespace: 'kb', kinds: ['semantic'] })).length, 1);
    assert.equal((await memory.search({ namespace: 'kb', tags: ['y'] })).length, 1);
    assert.equal((await memory.search({ namespace: 'kb', minImportance: 0.5 })).length, 1);
    assert.equal((await memory.search({ namespace: 'kb', text: 'alpha' })).length, 1);
  });

  it('updates content and preserves identity', async () => {
    const { memory } = engine();
    const record = await memory.remember({ namespace: 'kb', kind: 'semantic', content: 'original' });
    const updated = await memory.update('kb', record.id, { content: 'revised', importance: 0.8 });

    assert.equal(updated.id, record.id);
    assert.equal(updated.createdAt, record.createdAt);
    assert.equal(updated.content, 'revised');
    assert.equal(updated.importance, 0.8);
  });

  it('prunes the least valuable records when capacity is exceeded', async () => {
    const clock = clockAt();
    const memory = new PersistentMemoryEngine({ store: freshStore(), clock, capacityPerNamespace: 2 });

    await memory.remember({ namespace: 'cap', kind: 'working', content: 'low', importance: 0.1 });
    clock.advance(10);
    await memory.remember({ namespace: 'cap', kind: 'working', content: 'high', importance: 0.9 });
    clock.advance(10);
    await memory.remember({ namespace: 'cap', kind: 'working', content: 'medium', importance: 0.5 });

    const remaining = await memory.search({ namespace: 'cap' });
    assert.equal(remaining.length, 2);
    assert.ok(!remaining.some((record) => record.content === 'low'), 'the least important record must be evicted');
  });

  it('reports namespace statistics', async () => {
    const { memory } = engine();
    await memory.remember({ namespace: 'stats', kind: 'semantic', content: 'a', importance: 0.4 });
    await memory.remember({ namespace: 'stats', kind: 'episodic', content: 'b', importance: 0.6 });

    const statistics = await memory.statistics('stats');
    assert.equal(statistics.total, 2);
    assert.equal(statistics.byKind.semantic, 1);
    assert.ok(Math.abs(statistics.averageImportance - 0.5) < 1e-9);
  });

  it('consolidates expired memories', async () => {
    const { memory, clock } = engine();
    await memory.remember({ namespace: 'c', kind: 'working', content: 'ephemeral', ttlMs: 500 });
    await memory.remember({ namespace: 'c', kind: 'semantic', content: 'durable' });

    clock.advance(600);
    assert.equal(await memory.consolidate('c'), 1);
    assert.equal((await memory.search({ namespace: 'c' })).length, 1);
  });

  it('performs semantic search through the vector index', async () => {
    const clock = clockAt();
    const memory = new PersistentMemoryEngine({
      store: freshStore(),
      clock,
      vectors: new InMemoryVectorMemory('cosine'),
      embeddings: new HashEmbeddingProvider(64)
    });

    await memory.remember({ namespace: 'sem', kind: 'semantic', content: 'kubernetes container orchestration' });
    await memory.remember({ namespace: 'sem', kind: 'semantic', content: 'banana bread recipe' });

    const results = await memory.semanticSearch('sem', 'kubernetes container orchestration', 1);
    assert.equal(results.length, 1);
    assert.match(results[0]?.content ?? '', /kubernetes/);
  });

  it('requires vector configuration for semantic search', async () => {
    const { memory } = engine();
    await assert.rejects(() => memory.semanticSearch('x', 'query'), /requires both a vector index/);
  });

  it('clears an entire namespace', async () => {
    const { memory } = engine();
    await memory.remember({ namespace: 'wipe', kind: 'working', content: 'one' });
    await memory.remember({ namespace: 'wipe', kind: 'working', content: 'two' });

    assert.equal(await memory.clear('wipe'), 2);
    assert.equal((await memory.search({ namespace: 'wipe' })).length, 0);
  });
});

describe('InMemoryVectorMemory', () => {
  it('ranks results by cosine similarity', async () => {
    const vectors = new InMemoryVectorMemory('cosine');
    await vectors.upsert({ id: 'a', vector: [1, 0, 0], namespace: 'n', metadata: {} });
    await vectors.upsert({ id: 'b', vector: [0, 1, 0], namespace: 'n', metadata: {} });

    const results = await vectors.search({ vector: [1, 0, 0], namespace: 'n', topK: 2 });
    assert.equal(results[0]?.item.id, 'a');
    assert.ok((results[0]?.score ?? 0) > (results[1]?.score ?? 1));
  });

  it('rejects dimension mismatches and non-finite components', async () => {
    const vectors = new InMemoryVectorMemory();
    await vectors.upsert({ id: 'a', vector: [1, 2, 3], namespace: 'n', metadata: {} });

    await assert.rejects(() => vectors.upsert({ id: 'b', vector: [1, 2], namespace: 'n', metadata: {} }), /dimension mismatch/);
    await assert.rejects(
      () => vectors.upsert({ id: 'c', vector: [Number.NaN, 1, 1], namespace: 'n', metadata: {} }),
      /finite numbers/
    );
  });

  it('isolates namespaces and supports scoped clearing', async () => {
    const vectors = new InMemoryVectorMemory();
    await vectors.upsertMany([
      { id: 'a', vector: [1, 0], namespace: 'one', metadata: {} },
      { id: 'b', vector: [0, 1], namespace: 'two', metadata: {} }
    ]);

    assert.equal(await vectors.size('one'), 1);
    assert.equal((await vectors.search({ vector: [1, 0], namespace: 'one' })).length, 1);
    assert.equal(await vectors.clear('one'), 1);
    assert.equal(await vectors.size(), 1);
  });

  it('applies minScore and custom filters', async () => {
    const vectors = new InMemoryVectorMemory('cosine');
    await vectors.upsert({ id: 'a', vector: [1, 0], namespace: 'n', metadata: { keep: true } });
    await vectors.upsert({ id: 'b', vector: [-1, 0], namespace: 'n', metadata: { keep: false } });

    assert.equal((await vectors.search({ vector: [1, 0], minScore: 0.5 })).length, 1);
    assert.equal((await vectors.search({ vector: [1, 0], filter: (entry) => entry.metadata['keep'] === true })).length, 1);
  });
});

describe('embeddings and vector math', () => {
  it('produces deterministic, normalized embeddings', async () => {
    const provider = new HashEmbeddingProvider(32);
    const first = await provider.embed('nexus ai os');
    const second = await provider.embed('nexus ai os');

    assert.deepEqual(first, second);
    assert.equal(first.length, 32);
    assert.ok(Math.abs(Math.hypot(...first) - 1) < 1e-9, 'embedding must be unit length');
  });

  it('caches repeated embeddings', async () => {
    let calls = 0;
    const counting = {
      dimensions: 16,
      embed: async (text: string): Promise<readonly number[]> => {
        calls += 1;
        return hashEmbedding(text, 16);
      },
      embedMany: async (texts: readonly string[]): Promise<readonly (readonly number[])[]> =>
        texts.map((text) => hashEmbedding(text, 16))
    };
    const cached = new CachingEmbeddingProvider(counting, 10);

    await cached.embed('repeat');
    await cached.embed('repeat');
    assert.equal(calls, 1, 'the inner provider must only be consulted once');
  });

  it('computes similarity correctly', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-9);
    assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
    assert.deepEqual(normalize([0, 0]), [0, 0], 'zero vectors normalize to themselves');
  });
});
