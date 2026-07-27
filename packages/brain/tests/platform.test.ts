import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RecordEnvironmentSource } from '@nexus/core';
import { BrainConfigurationLoader, DEFAULT_BRAIN_CONFIGURATION } from '../src/config/index.js';
import { ContextEngine, HeuristicTokenEstimator } from '../src/context/index.js';
import { ConversationManager } from '../src/conversation/index.js';
import { KnowledgeGraph } from '../src/knowledge/index.js';
import { PersistentMemoryEngine } from '../src/memory/index.js';
import { PluginRegistry, type BrainPlugin } from '../src/plugins/index.js';
import { PromptManager } from '../src/prompt/index.js';
import { SessionManager } from '../src/session/index.js';
import { validateSchema } from '../src/utils/index.js';
import { clockAt, freshStore, testContext } from './helpers.js';

describe('KnowledgeGraph', () => {
  const populated = (): KnowledgeGraph => {
    const graph = new KnowledgeGraph(clockAt());
    graph.addNode({ id: 'a', type: 'service', label: 'API' });
    graph.addNode({ id: 'b', type: 'service', label: 'Worker' });
    graph.addNode({ id: 'c', type: 'database', label: 'Postgres' });
    graph.addEdge({ type: 'calls', from: 'a', to: 'b', weight: 1 });
    graph.addEdge({ type: 'reads', from: 'b', to: 'c', weight: 2 });
    return graph;
  };

  it('adds nodes and edges', () => {
    const graph = populated();
    assert.equal(graph.nodeCount, 3);
    assert.equal(graph.edgeCount, 2);
    assert.equal(graph.requireNode('a').label, 'API');
  });

  it('rejects duplicates, empty fields, and dangling edges', () => {
    const graph = populated();
    assert.throws(() => graph.addNode({ id: 'a', type: 'x', label: 'y' }), /already registered/);
    assert.throws(() => graph.addNode({ type: '', label: 'y' }), /type must not be empty/);
    assert.throws(() => graph.addEdge({ type: 'x', from: 'a', to: 'ghost' }), /not found/);
    assert.throws(() => graph.addEdge({ type: 'x', from: 'a', to: 'b', weight: 0 }), /positive finite/);
  });

  it('merges properties on upsert', () => {
    const graph = populated();
    graph.upsertNode({ id: 'a', type: 'service', label: 'API', properties: { tier: 1 } });
    graph.upsertNode({ id: 'a', type: 'service', label: 'API v2', properties: { region: 'eu' } });

    const node = graph.requireNode('a');
    assert.equal(node.label, 'API v2');
    assert.deepEqual(node.properties, { tier: 1, region: 'eu' });
  });

  it('finds nodes by type and property', () => {
    const graph = populated();
    graph.upsertNode({ id: 'c', type: 'database', label: 'Postgres', properties: { managed: true } });

    assert.equal(graph.findNodes({ type: 'service' }).length, 2);
    assert.equal(graph.findNodes({ properties: { managed: true } }).length, 1);
  });

  it('returns neighbours by direction', () => {
    const graph = populated();
    assert.deepEqual(graph.neighbors('b', 'outgoing').map((node) => node.id), ['c']);
    assert.deepEqual(graph.neighbors('b', 'incoming').map((node) => node.id), ['a']);
    assert.equal(graph.neighbors('b', 'both').length, 2);
  });

  it('traverses breadth-first within a depth limit', () => {
    const graph = populated();
    assert.deepEqual(graph.traverse('a', { maxDepth: 1 }).map((node) => node.id), ['b']);
    assert.deepEqual(graph.traverse('a', { maxDepth: 2 }).map((node) => node.id), ['b', 'c']);
  });

  it('computes the weighted shortest path', () => {
    const graph = populated();
    const path = graph.shortestPath('a', 'c');

    assert.deepEqual(path?.nodes, ['a', 'b', 'c']);
    assert.equal(path?.totalWeight, 3);
    assert.equal(graph.shortestPath('c', 'a'), undefined, 'edges are directed');
  });

  it('removes a node together with its edges', () => {
    const graph = populated();
    graph.removeNode('b');

    assert.equal(graph.nodeCount, 2);
    assert.equal(graph.edgeCount, 0, 'edges touching a removed node must be dropped');
  });

  it('round-trips through a snapshot', () => {
    const graph = populated();
    const snapshot = graph.snapshot();
    const restored = new KnowledgeGraph(clockAt());
    restored.restore(snapshot);

    assert.equal(restored.nodeCount, 3);
    assert.equal(restored.edgeCount, 2);
    assert.deepEqual(restored.shortestPath('a', 'c')?.nodes, ['a', 'b', 'c']);
  });
});

describe('ContextEngine', () => {
  it('packs fragments by priority within a budget', () => {
    const engine = new ContextEngine({ budget: 100 });
    const assembled = engine.pack(
      [
        engine.createFragment('instruction', 'critical instruction', { priority: 1_000 }),
        engine.createFragment('memory', 'x'.repeat(4_000), { priority: 10 })
      ],
      20
    );

    assert.equal(assembled.fragments.length, 1);
    assert.equal(assembled.droppedFragments.length, 1, 'oversized low-priority content must be reported as dropped');
    assert.ok(assembled.totalTokens <= 20);
  });

  it('assembles instructions, conversation, memory, and knowledge', async () => {
    const clock = clockAt();
    const memory = new PersistentMemoryEngine({ store: freshStore(), clock });
    await memory.remember({ namespace: 'ctx', kind: 'semantic', content: 'remembered detail', importance: 0.9 });

    const graph = new KnowledgeGraph(clock);
    graph.addNode({ id: 'n1', type: 'concept', label: 'Nexus' });

    const engine = new ContextEngine({ budget: 4_000, memory, graph });
    const assembled = await engine.assemble({
      context: testContext(),
      instructions: ['You are a helpful assistant.'],
      messages: [{ id: 'm1', role: 'user', content: 'Hello there', createdAt: '2024-01-01T00:00:00Z', metadata: {} }],
      memoryNamespace: 'ctx',
      knowledgeNodeIds: ['n1']
    });

    const sources = new Set(assembled.fragments.map((fragment) => fragment.source));
    assert.ok(sources.has('instruction'));
    assert.ok(sources.has('conversation'));
    assert.ok(sources.has('memory'));
    assert.ok(sources.has('knowledge'));
  });

  it('prioritizes recent conversation turns', async () => {
    const engine = new ContextEngine({ budget: 4_000 });
    const assembled = await engine.assemble({
      context: testContext(),
      messages: [
        { id: 'old', role: 'user', content: 'oldest', createdAt: '2024-01-01T00:00:00Z', metadata: {} },
        { id: 'new', role: 'user', content: 'newest', createdAt: '2024-01-02T00:00:00Z', metadata: {} }
      ]
    });

    assert.match(assembled.fragments[0]?.content ?? '', /newest/);
  });

  it('deduplicates identical fragments', async () => {
    const engine = new ContextEngine({ budget: 4_000 });
    const assembled = await engine.assemble({ context: testContext(), instructions: ['same', 'same'] });

    assert.equal(assembled.fragments.length, 1);
  });

  it('estimates tokens proportionally to length', () => {
    const estimator = new HeuristicTokenEstimator(4);
    assert.equal(estimator.estimate(''), 0);
    assert.ok(estimator.estimate('a'.repeat(400)) >= 100);
  });
});

describe('PromptManager', () => {
  it('registers and renders a template', () => {
    const prompts = new PromptManager(clockAt());
    prompts.register({
      id: 'greet',
      template: 'Hello {{ name }}, welcome to {{ product }}.',
      variables: [
        { name: 'name', description: 'User name', required: true },
        { name: 'product', description: 'Product name', required: false, defaultValue: 'Nexus' }
      ]
    });

    assert.equal(prompts.render('greet', { name: 'Aitzaz' }).text, 'Hello Aitzaz, welcome to Nexus.');
  });

  it('requires declared mandatory variables', () => {
    const prompts = new PromptManager(clockAt());
    prompts.register({
      id: 'strict',
      template: '{{ required }}',
      variables: [{ name: 'required', description: 'Needed', required: true }]
    });

    assert.throws(() => prompts.render('strict', {}), /requires variable/);
  });

  it('rejects undeclared placeholders at registration', () => {
    const prompts = new PromptManager(clockAt());
    assert.throws(
      () =>
        prompts.register({
          id: 'bad',
          template: '{{ known }} {{ unknown }}',
          variables: [{ name: 'known', description: 'k', required: true }]
        }),
      /undeclared placeholder/
    );
  });

  it('versions templates instead of overwriting', () => {
    const prompts = new PromptManager(clockAt());
    prompts.register({ id: 'v', template: 'version one' });
    prompts.addVersion({ id: 'v', template: 'version two' });

    assert.equal(prompts.get('v').version, 2);
    assert.equal(prompts.get('v').template, 'version two');
    assert.equal(prompts.get('v', 1).template, 'version one', 'older versions must remain renderable');
    assert.equal(prompts.versions('v').length, 2);
  });

  it('serializes non-string values and extracts placeholders', () => {
    const prompts = new PromptManager(clockAt());
    prompts.register({ id: 'json', template: 'Data: {{ payload }}' });

    assert.equal(prompts.render('json', { payload: { a: 1 } }).text, 'Data: {"a":1}');
    assert.deepEqual(PromptManager.extractPlaceholders('{{ a }} {{ b }} {{ a }}'), ['a', 'b']);
  });

  it('lists templates by tag', () => {
    const prompts = new PromptManager(clockAt());
    prompts.register({ id: 'one', template: 'x', tags: ['system'] });
    prompts.register({ id: 'two', template: 'y', tags: ['user'] });

    assert.equal(prompts.list('system').length, 1);
    assert.equal(prompts.list().length, 2);
  });
});

describe('ConversationManager', () => {
  const build = (overrides: { readonly compactionThreshold?: number; readonly retainRecent?: number } = {}): ConversationManager =>
    new ConversationManager({ store: freshStore(), clock: clockAt(), ...overrides });

  it('creates a conversation and appends messages', async () => {
    const manager = build();
    const conversation = await manager.create({ title: 'Test chat' });
    const updated = await manager.append(conversation.id, { role: 'user', content: 'Hi' });

    assert.equal(updated.messages.length, 1);
    assert.equal(updated.messages[0]?.role, 'user');
  });

  it('returns a token-bounded window of recent messages', async () => {
    const manager = build();
    const conversation = await manager.create();
    for (let index = 0; index < 20; index += 1) {
      await manager.append(conversation.id, { role: 'user', content: `message number ${index}` });
    }

    const window = await manager.window(conversation.id, 20);
    assert.ok(window.length > 0 && window.length < 20, 'the window must be truncated');
    assert.match(window.at(-1)?.content ?? '', /19/, 'the newest message must be retained');
  });

  it('compacts long transcripts while preserving recent turns', async () => {
    const manager = build({ compactionThreshold: 10, retainRecent: 3 });
    const conversation = await manager.create();
    for (let index = 0; index < 12; index += 1) {
      await manager.append(conversation.id, { role: index % 2 === 0 ? 'user' : 'assistant', content: `turn ${index}` });
    }

    const summary = await manager.compact(conversation.id);
    assert.ok(summary !== undefined);
    assert.equal(summary?.messageCount, 9);

    const after = await manager.require(conversation.id);
    assert.equal(after.messages.length, 4, 'one summary plus three retained turns');
    assert.equal(after.messages[0]?.metadata['compacted'], true);
  });

  it('does not compact short transcripts', async () => {
    const manager = build({ compactionThreshold: 10, retainRecent: 3 });
    const conversation = await manager.create();
    await manager.append(conversation.id, { role: 'user', content: 'only one' });

    assert.equal(await manager.compact(conversation.id), undefined);
  });

  it('accepts a custom summarizer', async () => {
    const manager = build({ compactionThreshold: 4, retainRecent: 1 });
    const conversation = await manager.create();
    for (let index = 0; index < 6; index += 1) {
      await manager.append(conversation.id, { role: 'user', content: `t${index}` });
    }

    const summary = await manager.compact(conversation.id, async (messages) => `custom summary of ${messages.length}`);
    assert.match(summary?.summary ?? '', /custom summary of 5/);
  });

  it('lists and deletes conversations', async () => {
    const manager = build();
    const conversation = await manager.create({ title: 'temp' });

    assert.equal((await manager.list()).length, 1);
    assert.equal(await manager.delete(conversation.id), true);
    assert.equal((await manager.list()).length, 0);
  });
});

describe('SessionManager', () => {
  it('creates and renews sessions', async () => {
    const clock = clockAt();
    const sessions = new SessionManager({ store: freshStore(), clock, ttlMs: 10_000, idleMs: 5_000 });
    const session = await sessions.create({ principal: { id: 'u1', tenantId: 't1', roles: [] } });

    assert.equal(session.status, 'active');
    clock.advance(6_000);
    assert.equal((await sessions.get(session.id))?.status, 'idle');

    const touched = await sessions.touch(session.id);
    assert.equal(touched.status, 'active');
  });

  it('expires sessions past their TTL', async () => {
    const clock = clockAt();
    const sessions = new SessionManager({ store: freshStore(), clock, ttlMs: 1_000, idleMs: 500 });
    const session = await sessions.create();

    clock.advance(1_001);
    assert.equal((await sessions.get(session.id))?.status, 'expired');
    await assert.rejects(() => sessions.require(session.id), /has expired/);
  });

  it('merges session state and enforces its size limit', async () => {
    const clock = clockAt();
    const sessions = new SessionManager({ store: freshStore(), clock, maxStateBytes: 200 });
    const session = await sessions.create();

    const updated = await sessions.setState(session.id, { step: 1 });
    assert.equal(updated.state['step'], 1);

    const merged = await sessions.setState(session.id, { other: 'x' });
    assert.deepEqual(merged.state, { step: 1, other: 'x' });

    await assert.rejects(() => sessions.setState(session.id, { big: 'x'.repeat(500) }), /exceeds the 200 byte limit/);
  });

  it('attaches conversations and terminates', async () => {
    const clock = clockAt();
    const sessions = new SessionManager({ store: freshStore(), clock });
    const session = await sessions.create();

    const attached = await sessions.attachConversation(session.id, 'conv-1');
    assert.deepEqual(attached.conversationIds, ['conv-1']);

    assert.equal((await sessions.terminate(session.id)).status, 'terminated');
    await assert.rejects(() => sessions.require(session.id), /was terminated/);
  });

  it('purges expired sessions', async () => {
    const clock = clockAt();
    const sessions = new SessionManager({ store: freshStore(), clock, ttlMs: 1_000, idleMs: 500 });
    await sessions.create();
    await sessions.create();

    clock.advance(1_001);
    assert.equal(await sessions.purge(), 2);
    assert.equal((await sessions.list()).length, 0);
  });

  it('validates its configuration', () => {
    assert.throws(() => new SessionManager({ store: freshStore(), ttlMs: 0 }), /must be positive/);
    assert.throws(() => new SessionManager({ store: freshStore(), ttlMs: 100, idleMs: 200 }), /must not exceed/);
  });
});

describe('PluginRegistry', () => {
  const plugin = (id: string, dependencies: readonly string[], log: string[]): BrainPlugin<{ readonly value: number }> => ({
    manifest: { id, name: id, version: '1.0.0', description: id, dependencies, provides: [`cap.${id}`] },
    activate: ({ onDispose }) => {
      log.push(`activate:${id}`);
      onDispose(() => void log.push(`dispose:${id}`));
    },
    deactivate: () => void log.push(`deactivate:${id}`)
  });

  it('activates dependencies before dependents', async () => {
    const log: string[] = [];
    const registry = new PluginRegistry({ value: 1 }, clockAt());
    registry.register(plugin('dependent', ['base'], log));
    registry.register(plugin('base', [], log));

    await registry.activate('dependent');
    assert.deepEqual(log, ['activate:base', 'activate:dependent']);
  });

  it('validates manifests', () => {
    const registry = new PluginRegistry({ value: 1 }, clockAt());
    assert.throws(() => registry.register(plugin('9bad', [], [])), /Invalid plugin id/);
    assert.throws(
      () => registry.register({ ...plugin('x', [], []), manifest: { ...plugin('x', [], []).manifest, version: 'one' } }),
      /must be semantic/
    );
  });

  it('detects dependency cycles', async () => {
    const registry = new PluginRegistry({ value: 1 }, clockAt());
    registry.register(plugin('a', ['b'], []));
    registry.register(plugin('b', ['a'], []));

    await assert.rejects(() => registry.activate('a'), /cycle/);
  });

  it('runs disposers when activation fails', async () => {
    const log: string[] = [];
    const registry = new PluginRegistry({ value: 1 }, clockAt());
    registry.register({
      manifest: { id: 'failing', name: 'failing', version: '1.0.0', description: 'fails' },
      activate: ({ onDispose }) => {
        onDispose(() => void log.push('cleaned'));
        throw new Error('activation failed');
      }
    });

    await assert.rejects(() => registry.activate('failing'), /activation failed/);
    assert.deepEqual(log, ['cleaned']);
    assert.equal(registry.statuses()[0]?.state, 'failed');
  });

  it('refuses to deactivate a plugin others depend on', async () => {
    const registry = new PluginRegistry({ value: 1 }, clockAt());
    registry.register(plugin('base', [], []));
    registry.register(plugin('dependent', ['base'], []));
    await registry.activateAll();

    await assert.rejects(() => registry.deactivate('base'), /is required by/);
    await registry.deactivate('dependent');
    await assert.doesNotReject(() => registry.deactivate('base'));
  });

  it('discovers plugins by capability', async () => {
    const registry = new PluginRegistry({ value: 1 }, clockAt());
    registry.register(plugin('finder', [], []));
    await registry.activateAll();

    assert.equal(registry.findByCapability('cap.finder').length, 1);
    assert.equal(registry.summary()['active'], 1);
  });
});

describe('BrainConfigurationLoader', () => {
  it('returns defaults for an empty environment', () => {
    const configuration = new BrainConfigurationLoader().load(new RecordEnvironmentSource({}));
    assert.deepEqual(configuration, DEFAULT_BRAIN_CONFIGURATION);
  });

  it('reads and validates overrides', () => {
    const configuration = new BrainConfigurationLoader().load(
      new RecordEnvironmentSource({
        NEXUS_BRAIN_MEMORY_CAPACITY: '500',
        NEXUS_BRAIN_VECTOR_METRIC: 'dot',
        NEXUS_BRAIN_CONTEXT_BUDGET: '2048'
      })
    );

    assert.equal(configuration.memory.capacityPerNamespace, 500);
    assert.equal(configuration.vectors.metric, 'dot');
    assert.equal(configuration.context.tokenBudget, 2_048);
  });

  it('rejects invalid values and inconsistent pairs', () => {
    const loader = new BrainConfigurationLoader();
    assert.throws(() => loader.load(new RecordEnvironmentSource({ NEXUS_BRAIN_VECTOR_METRIC: 'manhattan' })), /must be cosine/);
    assert.throws(() => loader.load(new RecordEnvironmentSource({ NEXUS_BRAIN_MEMORY_CAPACITY: '0' })), /between 1 and/);
    assert.throws(
      () =>
        loader.load(
          new RecordEnvironmentSource({ NEXUS_BRAIN_SESSION_TTL_MS: '1000', NEXUS_BRAIN_SESSION_IDLE_MS: '5000' })
        ),
      /must not exceed/
    );
  });

  it('produces a frozen configuration', () => {
    const configuration = new BrainConfigurationLoader().load(new RecordEnvironmentSource({}));
    assert.ok(Object.isFrozen(configuration));
    assert.ok(Object.isFrozen(configuration.memory));
  });
});

describe('schema validation', () => {
  it('accepts valid objects and reports every violation', () => {
    const schema = {
      type: 'object' as const,
      properties: { name: { type: 'string' as const, minLength: 2 }, age: { type: 'integer' as const, minimum: 0 } },
      required: ['name'],
      additionalProperties: false
    };

    assert.equal(validateSchema({ name: 'ok', age: 3 }, schema).ok, true);

    const failure = validateSchema({ name: 'x', age: -1, extra: true }, schema);
    assert.equal(failure.ok, false);
    if (!failure.ok) assert.equal(failure.error.length, 3);
  });

  it('validates enums, arrays, and nesting', () => {
    assert.equal(validateSchema('b', { type: 'string', enum: ['a', 'b'] }).ok, true);
    assert.equal(validateSchema('c', { type: 'string', enum: ['a', 'b'] }).ok, false);
    assert.equal(validateSchema([1, 2], { type: 'array', items: { type: 'integer' } }).ok, true);
    assert.equal(validateSchema([1, 'x'], { type: 'array', items: { type: 'integer' } }).ok, false);
    assert.equal(
      validateSchema(
        { outer: { inner: 5 } },
        { type: 'object', properties: { outer: { type: 'object', properties: { inner: { type: 'number' } } } } }
      ).ok,
      true
    );
  });

  it('distinguishes integers from floats and null from object', () => {
    assert.equal(validateSchema(1.5, { type: 'integer' }).ok, false);
    assert.equal(validateSchema(1.5, { type: 'number' }).ok, true);
    assert.equal(validateSchema(null, { type: 'null' }).ok, true);
    assert.equal(validateSchema(null, { type: 'object' }).ok, false);
  });
});
