import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgentRegistry, MultiAgentRuntime } from '../src/agents/index.js';
import { BrainEventBus } from '../src/events/index.js';
import { ToolRegistry, createCalculatorTool, evaluateArithmetic, type Tool } from '../src/tools/index.js';
import { clockAt, makeAgent, testContext } from './helpers.js';

const echoTool: Tool = {
  name: 'echo',
  description: 'Return the supplied message unchanged.',
  idempotent: true,
  inputSchema: {
    type: 'object',
    properties: { message: { type: 'string', minLength: 1 } },
    required: ['message'],
    additionalProperties: false
  },
  execute: async (input) => input
};

describe('ToolRegistry', () => {
  it('registers and describes tools', () => {
    const tools = new ToolRegistry({ clock: clockAt() });
    tools.register(echoTool);

    assert.ok(tools.has('echo'));
    assert.equal(tools.describe()[0]?.name, 'echo');
  });

  it('rejects duplicate and malformed registrations', () => {
    const tools = new ToolRegistry({ clock: clockAt() });
    tools.register(echoTool);

    assert.throws(() => tools.register(echoTool), /already registered/);
    assert.throws(() => tools.register({ ...echoTool, name: '9bad' }), /Invalid tool name/);
    assert.throws(() => tools.register({ ...echoTool, name: 'blank', description: '  ' }), /requires a description/);
  });

  it('invokes a tool and returns its output', async () => {
    const tools = new ToolRegistry({ clock: clockAt() });
    tools.register(echoTool);

    const result = await tools.invoke(ToolRegistry.call('echo', { message: 'hello' }), testContext());
    assert.equal(result.success, true);
    assert.deepEqual(result.output, { message: 'hello' });
  });

  it('rejects input violating the schema', async () => {
    const tools = new ToolRegistry({ clock: clockAt() });
    tools.register(echoTool);

    const result = await tools.invoke(ToolRegistry.call('echo', { wrong: 1 }), testContext());
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /Input validation failed/);
  });

  it('enforces required permissions', async () => {
    const tools = new ToolRegistry({
      clock: clockAt(),
      permissionResolver: (context) => context.principal?.roles ?? []
    });
    tools.register({ ...echoTool, requiredPermissions: ['tools:echo'] });

    const denied = await tools.invoke(ToolRegistry.call('echo', { message: 'x' }), testContext());
    assert.equal(denied.success, false);
    assert.match(denied.error ?? '', /Missing required permission/);

    const allowed = await tools.invoke(
      ToolRegistry.call('echo', { message: 'x' }),
      testContext({ principal: { id: 'u1', tenantId: 't1', roles: ['tools:echo'] } })
    );
    assert.equal(allowed.success, true);
  });

  it('retries idempotent tools and reports attempts', async () => {
    const tools = new ToolRegistry({ clock: clockAt(), maxRetries: 2 });
    let attempts = 0;
    tools.register({
      ...echoTool,
      name: 'flaky',
      idempotent: true,
      execute: async (input) => {
        attempts += 1;
        if (attempts < 3) throw new Error('transient failure');
        return input;
      }
    });

    const result = await tools.invoke(ToolRegistry.call('flaky', { message: 'ok' }), testContext());
    assert.equal(result.success, true);
    assert.equal(attempts, 3);
  });

  it('does not retry non-idempotent tools', async () => {
    const tools = new ToolRegistry({ clock: clockAt(), maxRetries: 3 });
    let attempts = 0;
    tools.register({
      ...echoTool,
      name: 'once',
      idempotent: false,
      execute: async () => {
        attempts += 1;
        throw new Error('boom');
      }
    });

    const result = await tools.invoke(ToolRegistry.call('once', { message: 'x' }), testContext());
    assert.equal(result.success, false);
    assert.equal(attempts, 1, 'non-idempotent tools must run at most once');
  });

  it('times out a hanging tool', async () => {
    const tools = new ToolRegistry({ clock: clockAt() });
    tools.register({
      ...echoTool,
      name: 'slow',
      timeoutMs: 20,
      idempotent: false,
      execute: async () => new Promise(() => undefined)
    });

    const result = await tools.invoke(ToolRegistry.call('slow', { message: 'x' }), testContext());
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /timed out/);
  });

  it('aborts when the caller cancels', async () => {
    const tools = new ToolRegistry({ clock: clockAt() });
    tools.register(echoTool);
    const controller = new AbortController();
    controller.abort();

    const result = await tools.invoke(ToolRegistry.call('echo', { message: 'x' }), testContext({ signal: controller.signal }));
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /aborted/);
  });

  it('runs several tools concurrently in order', async () => {
    const tools = new ToolRegistry({ clock: clockAt() });
    tools.register(echoTool);

    const results = await tools.invokeAll(
      [ToolRegistry.call('echo', { message: 'a' }), ToolRegistry.call('echo', { message: 'b' })],
      testContext()
    );
    assert.deepEqual(results.map((result) => (result.output as { message: string }).message), ['a', 'b']);
  });
});

describe('built-in calculator tool', () => {
  it('evaluates arithmetic with correct precedence', () => {
    assert.equal(evaluateArithmetic('2 + 3 * 4'), 14);
    assert.equal(evaluateArithmetic('(2 + 3) * 4'), 20);
    assert.equal(evaluateArithmetic('-5 + 10'), 5);
    assert.equal(evaluateArithmetic('7 / 2'), 3.5);
  });

  it('refuses unsafe or malformed expressions', () => {
    assert.throws(() => evaluateArithmetic('process.exit(1)'), /unsupported characters/);
    assert.throws(() => evaluateArithmetic('1 / 0'), /Division by zero/);
    assert.throws(() => evaluateArithmetic('(1 + 2'), /Unexpected end|Unbalanced/);
  });

  it('is callable through the registry', async () => {
    const tools = new ToolRegistry({ clock: clockAt() });
    tools.register(createCalculatorTool());

    const result = await tools.invoke(ToolRegistry.call('calculator', { expression: '6 * 7' }), testContext());
    assert.equal(result.success, true);
    assert.equal((result.output as { result: number }).result, 42);
  });
});

describe('AgentRegistry', () => {
  it('registers agents and matches them by capability', () => {
    const registry = new AgentRegistry(clockAt());
    registry.register(makeAgent('writer', ['write'], () => ({})));
    registry.register(makeAgent('analyst', ['analyze'], () => ({})));

    assert.equal(registry.findByCapabilities(['write']).length, 1);
    assert.equal(registry.select({ requiredCapabilities: ['analyze'] })?.manifest.id, 'analyst');
    assert.equal(registry.select({ requiredCapabilities: ['fly'] }), undefined);
  });

  it('validates manifests', () => {
    const registry = new AgentRegistry(clockAt());
    assert.throws(() => registry.register(makeAgent('9bad', ['x'], () => ({}))), /Invalid agent id/);
    assert.throws(() => registry.register(makeAgent('nocap', [], () => ({}))), /at least one capability/);

    registry.register(makeAgent('dup', ['x'], () => ({})));
    assert.throws(() => registry.register(makeAgent('dup', ['x'], () => ({}))), /already registered/);
  });

  it('tracks concurrency and refuses work beyond the limit', () => {
    const registry = new AgentRegistry(clockAt());
    registry.register(makeAgent('solo', ['x'], () => ({}), { maxConcurrency: 1 }));

    registry.acquire('solo');
    assert.equal(registry.getRecord('solo').status, 'busy');
    assert.equal(registry.select({ requiredCapabilities: ['x'] }), undefined, 'a saturated agent must not be selected');
    assert.throws(() => registry.acquire('solo'), /concurrency limit/);

    registry.release('solo', true);
    assert.equal(registry.getRecord('solo').status, 'idle');
    assert.equal(registry.getRecord('solo').completedTasks, 1);
  });

  it('prefers the least loaded agent', () => {
    const registry = new AgentRegistry(clockAt());
    registry.register(makeAgent('a', ['x'], () => ({}), { maxConcurrency: 2 }));
    registry.register(makeAgent('b', ['x'], () => ({}), { maxConcurrency: 2 }));
    registry.acquire('a');

    assert.equal(registry.select({ requiredCapabilities: ['x'] })?.manifest.id, 'b');
  });

  it('disables and re-enables agents', () => {
    const registry = new AgentRegistry(clockAt());
    registry.register(makeAgent('toggle', ['x'], () => ({})));

    registry.disable('toggle', 'maintenance');
    assert.equal(registry.select({ requiredCapabilities: ['x'] }), undefined);
    registry.enable('toggle');
    assert.ok(registry.select({ requiredCapabilities: ['x'] }) !== undefined);
  });

  it('reports aggregate statistics', () => {
    const registry = new AgentRegistry(clockAt());
    registry.register(makeAgent('a', ['x'], () => ({})));
    registry.acquire('a');
    registry.release('a', false, 'failed');

    const statistics = registry.statistics();
    assert.equal(statistics['total'], 1);
    assert.equal(statistics['failedTasks'], 1);
  });
});

describe('MultiAgentRuntime', () => {
  const build = (): { readonly registry: AgentRegistry; readonly runtime: MultiAgentRuntime; readonly events: BrainEventBus } => {
    const clock = clockAt();
    const registry = new AgentRegistry(clock);
    const events = new BrainEventBus({ clock });
    const runtime = new MultiAgentRuntime({ registry, tools: new ToolRegistry({ clock }), events, clock });
    return { registry, runtime, events };
  };

  it('dispatches to a capable agent', async () => {
    const { registry, runtime } = build();
    registry.register(makeAgent('worker', ['work'], (task) => ({ output: { echoed: task.goal } })));

    const result = await runtime.dispatch(AgentRegistry.task({ goal: 'do it', requiredCapabilities: ['work'] }), testContext());
    assert.equal(result.success, true);
    assert.deepEqual(result.output, { echoed: 'do it' });
  });

  it('fails when no agent has the capability', async () => {
    const { runtime } = build();
    await assert.rejects(
      () => runtime.dispatch(AgentRegistry.task({ goal: 'x', requiredCapabilities: ['missing'] }), testContext()),
      /No available agent/
    );
  });

  it('converts an agent throw into a failed result and frees the agent', async () => {
    const { registry, runtime } = build();
    registry.register(
      makeAgent('breaker', ['x'], () => {
        throw new Error('agent exploded');
      })
    );

    const result = await runtime.run('breaker', AgentRegistry.task({ goal: 'x' }), testContext());
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /agent exploded/);
    assert.equal(registry.getRecord('breaker').activeTasks, 0, 'a crashed agent must be released');
  });

  it('times out a hanging agent', async () => {
    const { registry, runtime } = build();
    registry.register(makeAgent('hang', ['x'], async () => new Promise(() => undefined), { timeoutMs: 20 }));

    const result = await runtime.run('hang', AgentRegistry.task({ goal: 'x' }), testContext());
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /timed out/);
  });

  it('threads output between agents in sequential mode', async () => {
    const { registry, runtime } = build();
    registry.register(makeAgent('first', ['x'], () => ({ output: { step: 1 } })));
    registry.register(
      makeAgent('second', ['x'], (task) => ({ output: { received: task.input, step: 2 } }))
    );

    const result = await runtime.collaborate({
      goal: 'chain',
      agentIds: ['first', 'second'],
      mode: 'sequential',
      context: testContext()
    });

    assert.equal(result.success, true);
    assert.deepEqual((result.output as { received: unknown }).received, { step: 1 });
  });

  it('runs agents concurrently in parallel mode', async () => {
    const { registry, runtime } = build();
    registry.register(makeAgent('p1', ['x'], () => ({ output: { from: 'p1' } })));
    registry.register(makeAgent('p2', ['x'], () => ({ output: { from: 'p2' } })));

    const result = await runtime.collaborate({ goal: 'fan out', agentIds: ['p1', 'p2'], mode: 'parallel', context: testContext() });
    assert.equal(result.results.length, 2);
    assert.equal(result.success, true);
  });

  it('keeps the first success in competitive mode', async () => {
    const { registry, runtime } = build();
    registry.register(makeAgent('loser', ['x'], () => ({ success: false, error: 'nope' })));
    registry.register(makeAgent('winner', ['x'], () => ({ output: { won: true } })));

    const result = await runtime.collaborate({
      goal: 'race',
      agentIds: ['loser', 'winner'],
      mode: 'competitive',
      context: testContext()
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.output, { won: true });
  });

  it('supports delegation between agents', async () => {
    const clock = clockAt();
    const registry = new AgentRegistry(clock);
    const runtime = new MultiAgentRuntime({ registry, tools: new ToolRegistry({ clock }), clock });

    registry.register(makeAgent('helper', ['help'], () => ({ output: { helped: true } })));
    registry.register({
      manifest: { id: 'boss', name: 'boss', description: 'Delegates work', capabilities: ['manage'] },
      execute: async (task, context, services) => {
        const delegated = await services.delegate(
          { goal: 'assist', input: {}, requiredCapabilities: ['help'], priority: 0, metadata: {} },
          context
        );
        return { taskId: task.id, agentId: 'boss', success: true, output: delegated.output, durationMs: 0, toolCalls: [] };
      }
    });

    const result = await runtime.run('boss', AgentRegistry.task({ goal: 'manage' }), testContext());
    assert.deepEqual(result.output, { helped: true });
  });

  it('delivers messages between agents', () => {
    const { runtime } = build();
    runtime.send({ from: 'a', to: 'b', subject: 'ping', body: { n: 1 } });

    assert.equal(runtime.pendingMessages('b'), 1);
    assert.equal(runtime.receive('b').length, 1);
    assert.equal(runtime.pendingMessages('b'), 0, 'receiving must drain the mailbox');
  });

  it('emits lifecycle events', async () => {
    const { registry, runtime, events } = build();
    registry.register(makeAgent('emitter', ['x'], () => ({})));

    await runtime.run('emitter', AgentRegistry.task({ goal: 'x' }), testContext());
    assert.equal(events.getHistory('agent.invoked').length, 1);
    assert.equal(events.getHistory('agent.completed').length, 1);
  });
});
