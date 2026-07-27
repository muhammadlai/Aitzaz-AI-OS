import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HealthMonitor, MemoryKeyValueStore, RecordEnvironmentSource } from '@nexus/core';
import { AgentRegistry } from '../src/agents/index.js';
import { ApiGateway, createBrainGateway, type Route } from '../src/gateway/index.js';
import { BrainKernel } from '../src/kernel/index.js';
import { ToolRegistry } from '../src/tools/index.js';
import { clockAt, makeAgent } from './helpers.js';

const kernel = (): BrainKernel => new BrainKernel({ store: new MemoryKeyValueStore(), clock: clockAt() });

describe('BrainKernel', () => {
  it('wires every subsystem', () => {
    const brain = kernel();
    const { services } = brain;

    for (const key of [
      'memory',
      'vectors',
      'knowledge',
      'context',
      'reasoning',
      'planning',
      'decisions',
      'workflows',
      'scheduler',
      'tools',
      'agents',
      'runtime',
      'prompts',
      'conversations',
      'sessions',
      'plugins',
      'metrics',
      'events'
    ] as const) {
      assert.ok(services[key] !== undefined, `${key} must be wired`);
    }
  });

  it('installs the default tool catalogue', () => {
    const names = kernel().services.tools.list().map((tool) => tool.name).sort();
    assert.deepEqual(names, ['calculator', 'current_time', 'knowledge_query', 'memory_search', 'memory_write']);
  });

  it('can omit default tools', () => {
    const brain = new BrainKernel({ store: new MemoryKeyValueStore(), clock: clockAt(), installDefaultTools: false });
    assert.equal(brain.services.tools.list().length, 0);
  });

  it('transitions through its lifecycle', async () => {
    const brain = kernel();
    assert.equal(brain.currentState, 'created');

    await brain.start();
    assert.equal(brain.currentState, 'running');

    await brain.stop();
    assert.equal(brain.currentState, 'stopped');
  });

  it('exposes the plugin registry to plugins themselves', async () => {
    const brain = kernel();
    let sawTools = 0;
    brain.services.plugins.register({
      manifest: { id: 'inspector', name: 'inspector', version: '1.0.0', description: 'Counts tools' },
      activate: ({ services }) => {
        sawTools = services.tools.list().length;
      }
    });

    await brain.start();
    assert.equal(sawTools, 5, 'a plugin must observe the fully wired services');
  });

  it('builds from environment values', () => {
    const brain = BrainKernel.fromEnvironment(new RecordEnvironmentSource({ NEXUS_BRAIN_CONTEXT_BUDGET: '1024' }), {
      store: new MemoryKeyValueStore()
    });
    assert.equal(brain.services.configuration.context.tokenBudget, 1_024);
  });

  it('registers health checks that report accurately', async () => {
    const brain = kernel();
    const health = new HealthMonitor();
    brain.registerHealthChecks(health);

    const report = await health.inspect();
    assert.ok(report.checks['brain.memory'] !== undefined);
    assert.equal(report.checks['brain.memory']?.status, 'healthy');
    assert.equal(report.checks['brain.tools']?.status, 'healthy');
    assert.equal(report.checks['brain.agents']?.status, 'degraded', 'no agents registered yet');
  });

  it('describes its operational state', () => {
    const brain = kernel();
    brain.services.agents.register(makeAgent('a', ['x'], () => ({})));

    const description = brain.describe();
    assert.equal(description['tools'], 5);
    assert.equal(description['agents'], 1);
  });

  it('performs an end-to-end cognition cycle', async () => {
    const brain = kernel();
    const { services } = brain;
    await brain.start();

    // Memory, knowledge, tools, agents, and workflows cooperating on one goal.
    await services.memory.remember({ namespace: 'ops', kind: 'semantic', content: 'The API budget is 500 dollars' });
    services.knowledge.addNode({ id: 'api', type: 'service', label: 'API' });

    services.agents.register(
      makeAgent('summarizer', ['summarize'], async () => {
        const found = await services.memory.search({ namespace: 'ops', text: 'budget' });
        return { output: { recalled: found.length } };
      })
    );

    const result = await services.runtime.dispatch(
      AgentRegistry.task({ goal: 'summarize the budget', requiredCapabilities: ['summarize'] }),
      { correlationId: 'e2e', signal: new AbortController().signal, metadata: {} }
    );

    assert.equal(result.success, true);
    assert.equal((result.output as { recalled: number }).recalled, 1);

    const calculation = await services.tools.invoke(ToolRegistry.call('calculator', { expression: '500 / 2' }), {
      correlationId: 'e2e',
      signal: new AbortController().signal,
      metadata: {}
    });
    assert.equal((calculation.output as { result: number }).result, 250);

    await brain.stop();
  });
});

describe('ApiGateway', () => {
  const helloRoute: Route = {
    method: 'GET',
    path: '/hello/:name',
    description: 'Greets a caller.',
    handle: (context) => ApiGateway.ok({ greeting: `hello ${context.params['name']}` })
  };

  it('routes requests and extracts path parameters', async () => {
    const gateway = new ApiGateway(clockAt());
    gateway.register(helloRoute);

    const response = await gateway.handle(ApiGateway.request({ method: 'GET', path: '/hello/world' }));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { greeting: 'hello world' });
  });

  it('returns 404 for unmatched routes', async () => {
    const gateway = new ApiGateway(clockAt());
    const response = await gateway.handle(ApiGateway.request({ method: 'GET', path: '/nothing' }));
    assert.equal(response.status, 404);
  });

  it('rejects duplicate route registrations', () => {
    const gateway = new ApiGateway(clockAt());
    gateway.register(helloRoute);
    assert.throws(() => gateway.register(helloRoute), /already registered/);
    assert.throws(() => gateway.register({ ...helloRoute, path: 'no-slash' }), /must start with/);
  });

  it('validates request bodies against a schema', async () => {
    const gateway = new ApiGateway(clockAt());
    gateway.register({
      method: 'POST',
      path: '/items',
      description: 'Creates an item.',
      bodySchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      handle: () => ApiGateway.ok({ created: true }, 201)
    });

    assert.equal((await gateway.handle(ApiGateway.request({ method: 'POST', path: '/items', body: { name: 'x' } }))).status, 201);

    const invalid = await gateway.handle(ApiGateway.request({ method: 'POST', path: '/items', body: {} }));
    assert.equal(invalid.status, 400);
  });

  it('enforces authentication and permissions', async () => {
    const gateway = new ApiGateway(clockAt());
    gateway.register({
      method: 'GET',
      path: '/secure',
      description: 'Protected route.',
      requiredPermissions: ['admin'],
      handle: () => ApiGateway.ok({ secret: true })
    });

    assert.equal((await gateway.handle(ApiGateway.request({ method: 'GET', path: '/secure' }))).status, 401);

    const forbidden = await gateway.handle(
      ApiGateway.request({ method: 'GET', path: '/secure', principal: { id: 'u', tenantId: 't', roles: ['user'] } })
    );
    assert.equal(forbidden.status, 403);

    const allowed = await gateway.handle(
      ApiGateway.request({ method: 'GET', path: '/secure', principal: { id: 'u', tenantId: 't', roles: ['admin'] } })
    );
    assert.equal(allowed.status, 200);
  });

  it('applies rate limits per caller and resets the window', async () => {
    const clock = clockAt();
    const gateway = new ApiGateway(clock);
    gateway.register({
      method: 'GET',
      path: '/limited',
      description: 'Rate limited.',
      rateLimit: { limit: 2, windowMs: 1_000 },
      handle: () => ApiGateway.ok({ ok: true })
    });

    const send = (): Promise<{ readonly status: number }> => gateway.handle(ApiGateway.request({ method: 'GET', path: '/limited' }));
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 429);

    clock.advance(1_001);
    assert.equal((await send()).status, 200, 'the window must reset');
  });

  it('runs middleware around handlers', async () => {
    const gateway = new ApiGateway(clockAt());
    const order: string[] = [];
    gateway.use(async (_, next) => {
      order.push('before');
      const response = await next();
      order.push('after');
      return response;
    });
    gateway.register({
      method: 'GET',
      path: '/mw',
      description: 'Middleware target.',
      handle: () => {
        order.push('handler');
        return ApiGateway.ok({});
      }
    });

    await gateway.handle(ApiGateway.request({ method: 'GET', path: '/mw' }));
    assert.deepEqual(order, ['before', 'handler', 'after']);
  });

  it('converts handler errors into structured responses', async () => {
    const gateway = new ApiGateway(clockAt());
    gateway.register({
      method: 'GET',
      path: '/boom',
      description: 'Throws.',
      handle: () => {
        throw new Error('handler exploded');
      }
    });

    const response = await gateway.handle(ApiGateway.request({ method: 'GET', path: '/boom' }));
    assert.equal(response.status, 500);
    assert.match(JSON.stringify(response.body), /handler exploded/);
  });

  it('attaches a correlation id to every response', async () => {
    const gateway = new ApiGateway(clockAt());
    gateway.register(helloRoute);

    const response = await gateway.handle(
      ApiGateway.request({ method: 'GET', path: '/hello/x', headers: { 'x-correlation-id': 'abc-123' } })
    );
    assert.equal(response.headers['x-correlation-id'], 'abc-123');
  });
});

describe('brain route table', () => {
  it('serves the status endpoint', async () => {
    const brain = kernel();
    const gateway = createBrainGateway(brain.services);

    const response = await gateway.handle(ApiGateway.request({ method: 'GET', path: '/v2/brain/status' }));
    assert.equal(response.status, 200);
    assert.equal((response.body as { tools: number }).tools, 5);
  });

  it('lists tool descriptors', async () => {
    const brain = kernel();
    const gateway = createBrainGateway(brain.services);

    const response = await gateway.handle(ApiGateway.request({ method: 'GET', path: '/v2/tools' }));
    assert.equal((response.body as unknown[]).length, 5);
  });

  it('invokes a tool through the gateway with permission', async () => {
    const brain = kernel();
    const gateway = createBrainGateway(brain.services);

    const response = await gateway.handle(
      ApiGateway.request({
        method: 'POST',
        path: '/v2/tools/calculator/invoke',
        body: { input: { expression: '2+2' } },
        principal: { id: 'u', tenantId: 't', roles: ['brain:tools:invoke'] }
      })
    );

    assert.equal(response.status, 200);
    assert.equal((response.body as { output: { result: number } }).output.result, 4);
  });

  it('refuses tool invocation without permission', async () => {
    const brain = kernel();
    const gateway = createBrainGateway(brain.services);

    const response = await gateway.handle(
      ApiGateway.request({ method: 'POST', path: '/v2/tools/calculator/invoke', body: { input: {} } })
    );
    assert.equal(response.status, 401);
  });

  it('writes and reads memory through the gateway', async () => {
    const brain = kernel();
    const gateway = createBrainGateway(brain.services);
    const principal = { id: 'u', tenantId: 't', roles: ['brain:memory:write'] };

    const created = await gateway.handle(
      ApiGateway.request({ method: 'POST', path: '/v2/memory/notes', body: { content: 'remember this' }, principal })
    );
    assert.equal(created.status, 201);

    const listed = await gateway.handle(ApiGateway.request({ method: 'GET', path: '/v2/memory/notes' }));
    assert.equal((listed.body as unknown[]).length, 1);
  });

  it('reports 404 for an unknown tool', async () => {
    const brain = kernel();
    const gateway = createBrainGateway(brain.services);

    const response = await gateway.handle(
      ApiGateway.request({
        method: 'POST',
        path: '/v2/tools/ghost/invoke',
        body: { input: {} },
        principal: { id: 'u', tenantId: 't', roles: ['brain:tools:invoke'] }
      })
    );
    assert.equal(response.status, 404);
  });

  it('creates a session through the gateway', async () => {
    const brain = kernel();
    const gateway = createBrainGateway(brain.services);

    const response = await gateway.handle(ApiGateway.request({ method: 'POST', path: '/v2/sessions', body: {} }));
    assert.equal(response.status, 201);
    assert.equal((response.body as { status: string }).status, 'active');
  });
});
