import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BrainEventBus } from '../src/events/index.js';
import { BrainTaskScheduler } from '../src/scheduler/index.js';
import { WorkflowEngine, type WorkflowDefinition } from '../src/workflow/index.js';
import { clockAt, testContext } from './helpers.js';

describe('WorkflowEngine', () => {
  const linear = (log: string[]): WorkflowDefinition => ({
    id: 'linear',
    name: 'Linear workflow',
    description: 'Two dependent steps',
    version: 1,
    steps: [
      {
        id: 'first',
        name: 'First',
        run: async () => {
          log.push('first');
          return { value: 1 };
        }
      },
      {
        id: 'second',
        name: 'Second',
        dependsOn: ['first'],
        run: async (context) => {
          log.push('second');
          return { previous: context.state.outputs['first'] ?? null };
        }
      }
    ]
  });

  it('executes steps in dependency order and threads outputs', async () => {
    const log: string[] = [];
    const engine = new WorkflowEngine({ clock: clockAt() });
    engine.register(linear(log));

    const run = await engine.execute('linear', { seed: true }, testContext());
    assert.equal(run.status, 'completed');
    assert.deepEqual(log, ['first', 'second']);
    assert.deepEqual(run.state.outputs['second'], { previous: { value: 1 } });
  });

  it('rejects cycles and unknown dependencies at registration', () => {
    const engine = new WorkflowEngine({ clock: clockAt() });
    assert.throws(
      () =>
        engine.register({
          id: 'cyclic',
          name: 'c',
          description: 'c',
          version: 1,
          steps: [
            { id: 'a', name: 'a', dependsOn: ['b'], run: async () => null },
            { id: 'b', name: 'b', dependsOn: ['a'], run: async () => null }
          ]
        }),
      /dependency cycle/
    );
    assert.throws(
      () =>
        engine.register({
          id: 'missing',
          name: 'm',
          description: 'm',
          version: 1,
          steps: [{ id: 'a', name: 'a', dependsOn: ['ghost'], run: async () => null }]
        }),
      /unknown step/
    );
  });

  it('runs independent steps concurrently', async () => {
    const engine = new WorkflowEngine({ clock: clockAt() });
    let active = 0;
    let peak = 0;
    const parallelStep = (id: string) => ({
      id,
      name: id,
      run: async (): Promise<null> => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return null;
      }
    });

    engine.register({
      id: 'fan',
      name: 'fan',
      description: 'Parallel branches',
      version: 1,
      steps: [parallelStep('a'), parallelStep('b'), parallelStep('c')]
    });

    await engine.execute('fan', {}, testContext());
    assert.ok(peak > 1, 'independent steps must overlap');
  });

  it('retries a failing step according to its policy', async () => {
    const engine = new WorkflowEngine({ clock: clockAt() });
    let attempts = 0;
    engine.register({
      id: 'retry',
      name: 'retry',
      description: 'Retries once',
      version: 1,
      steps: [
        {
          id: 'flaky',
          name: 'flaky',
          retry: { maxAttempts: 3, backoffMs: 1 },
          run: async () => {
            attempts += 1;
            if (attempts < 3) throw new Error('not yet');
            return { attempts };
          }
        }
      ]
    });

    const run = await engine.execute('retry', {}, testContext());
    assert.equal(run.status, 'completed');
    assert.equal(run.executions[0]?.attempts, 3);
  });

  it('marks the run failed when a step exhausts retries', async () => {
    const engine = new WorkflowEngine({ clock: clockAt() });
    engine.register({
      id: 'fail',
      name: 'fail',
      description: 'Always fails',
      version: 1,
      steps: [{ id: 'bad', name: 'bad', run: async () => Promise.reject(new Error('permanent')) }]
    });

    const run = await engine.execute('fail', {}, testContext());
    assert.equal(run.status, 'failed');
    assert.match(run.error ?? '', /permanent/);
  });

  it('compensates completed steps in reverse order on failure', async () => {
    const compensated: string[] = [];
    const engine = new WorkflowEngine({ clock: clockAt() });
    engine.register({
      id: 'saga',
      name: 'saga',
      description: 'Compensating workflow',
      version: 1,
      compensateOnFailure: true,
      steps: [
        {
          id: 'reserve',
          name: 'reserve',
          run: async () => ({ reserved: true }),
          compensate: async () => {
            compensated.push('reserve');
          }
        },
        {
          id: 'charge',
          name: 'charge',
          dependsOn: ['reserve'],
          run: async () => ({ charged: true }),
          compensate: async () => {
            compensated.push('charge');
          }
        },
        { id: 'ship', name: 'ship', dependsOn: ['charge'], run: async () => Promise.reject(new Error('out of stock')) }
      ]
    });

    const run = await engine.execute('saga', {}, testContext());
    assert.equal(run.status, 'compensated');
    assert.deepEqual(compensated, ['charge', 'reserve'], 'compensation must run in reverse order');
  });

  it('skips steps whose condition is false', async () => {
    const engine = new WorkflowEngine({ clock: clockAt() });
    engine.register({
      id: 'conditional',
      name: 'conditional',
      description: 'Conditional step',
      version: 1,
      steps: [
        { id: 'always', name: 'always', run: async () => ({ ok: true }) },
        { id: 'never', name: 'never', dependsOn: ['always'], when: () => false, run: async () => ({ ran: true }) }
      ]
    });

    const run = await engine.execute('conditional', {}, testContext());
    assert.equal(run.status, 'completed');
    assert.equal(run.executions.find((execution) => execution.stepId === 'never')?.status, 'skipped');
  });

  it('times out a hanging step', async () => {
    const engine = new WorkflowEngine({ clock: clockAt() });
    engine.register({
      id: 'slow',
      name: 'slow',
      description: 'Hangs',
      version: 1,
      steps: [{ id: 'wait', name: 'wait', timeoutMs: 20, run: async () => new Promise<null>(() => undefined) }]
    });

    const run = await engine.execute('slow', {}, testContext());
    assert.equal(run.status, 'failed');
    assert.match(run.error ?? '', /timed out/);
  });

  it('emits workflow lifecycle events', async () => {
    const clock = clockAt();
    const events = new BrainEventBus({ clock });
    const engine = new WorkflowEngine({ clock, events });
    engine.register(linear([]));

    await engine.execute('linear', {}, testContext());
    assert.equal(events.getHistory('workflow.started').length, 1);
    assert.equal(events.getHistory('workflow.completed').length, 1);
  });
});

describe('BrainTaskScheduler', () => {
  it('runs due jobs highest priority first', async () => {
    const clock = clockAt();
    const scheduler = new BrainTaskScheduler({ clock, concurrency: 1 });
    const order: string[] = [];

    scheduler.enqueue({ name: 'low', priority: 1 }, async () => {
      order.push('low');
      return null;
    });
    scheduler.enqueue({ name: 'high', priority: 10 }, async () => {
      order.push('high');
      return null;
    });

    await scheduler.drain();
    assert.deepEqual(order, ['high', 'low']);
  });

  it('defers delayed jobs until their time arrives', async () => {
    const clock = clockAt();
    const scheduler = new BrainTaskScheduler({ clock });
    scheduler.enqueue({ name: 'later', delayMs: 1_000 }, async () => 'done');

    assert.equal(scheduler.dueJobs().length, 0);
    await scheduler.drain();
    assert.equal(scheduler.size, 1, 'the job must remain queued');

    clock.advance(1_000);
    assert.equal(scheduler.dueJobs().length, 1);
    const completed = await scheduler.drain();
    assert.equal(completed[0]?.status, 'succeeded');
  });

  it('retries with backoff and finally dead-letters', async () => {
    const clock = clockAt();
    const dead: string[] = [];
    const scheduler = new BrainTaskScheduler({ clock, onDeadLetter: (job) => void dead.push(job.name) });
    scheduler.enqueue({ name: 'doomed', maxAttempts: 2, backoffMs: 100 }, async () => {
      throw new Error('always fails');
    });

    await scheduler.drain();
    assert.equal(scheduler.size, 1, 'the job must be requeued for its retry');

    clock.advance(100);
    await scheduler.drain();
    assert.deepEqual(dead, ['doomed']);
    assert.equal(scheduler.deadLetters().length, 1);
  });

  it('records successful results', async () => {
    const clock = clockAt();
    const scheduler = new BrainTaskScheduler({ clock });
    const job = scheduler.enqueue({ name: 'compute' }, async () => 42);

    await scheduler.drain();
    assert.equal(scheduler.get(job.id).status, 'succeeded');
    assert.equal(scheduler.get(job.id).result, 42);
  });

  it('cancels a queued job', () => {
    const clock = clockAt();
    const scheduler = new BrainTaskScheduler({ clock });
    const job = scheduler.enqueue({ name: 'cancelme', delayMs: 5_000 }, async () => null);

    assert.equal(scheduler.cancel(job.id).status, 'cancelled');
    assert.equal(scheduler.size, 0);
  });

  it('validates enqueue options', () => {
    const scheduler = new BrainTaskScheduler({ clock: clockAt() });
    assert.throws(() => scheduler.enqueue({ name: '' }, async () => null), /must not be empty/);
    assert.throws(() => scheduler.enqueue({ name: 'x', maxAttempts: 0 }, async () => null), /positive integer/);
    assert.throws(() => scheduler.enqueue({ name: 'x', delayMs: -1 }, async () => null), /non-negative/);
  });
});

describe('BrainEventBus', () => {
  it('publishes typed events to subscribers', async () => {
    const bus = new BrainEventBus({ clock: clockAt() });
    const seen: string[] = [];
    bus.on('memory.stored', (envelope) => void seen.push(envelope.payload.memoryId));

    await bus.publish('memory.stored', { memoryId: 'm1', namespace: 'n', kind: 'semantic' });
    assert.deepEqual(seen, ['m1']);
  });

  it('isolates producers from failing subscribers', async () => {
    const bus = new BrainEventBus({ clock: clockAt() });
    bus.on('session.created', () => {
      throw new Error('subscriber failed');
    });

    await assert.doesNotReject(() => bus.publish('session.created', { sessionId: 's1' }));
    assert.equal(bus.getDeadLetters().length, 1);
  });

  it('supports wildcard subscription and custom events', async () => {
    const bus = new BrainEventBus({ clock: clockAt() });
    const types: string[] = [];
    bus.onAny((type) => void types.push(type));

    await bus.publish('session.expired', { sessionId: 's1' });
    await bus.publishCustom('custom.thing', { any: true });
    assert.deepEqual(types, ['session.expired', 'custom.thing']);
  });

  it('bounds the replay buffer and replays on demand', async () => {
    const bus = new BrainEventBus({ clock: clockAt(), historyLimit: 2 });
    for (let index = 0; index < 5; index += 1) {
      await bus.publish('session.created', { sessionId: `s${index}` });
    }
    assert.equal(bus.getHistory().length, 2, 'history must respect its limit');

    const replayed: string[] = [];
    bus.on('session.created', (envelope) => void replayed.push(envelope.payload.sessionId));
    assert.equal(await bus.replay('session.created'), 2);
    assert.equal(replayed.length, 2);
  });

  it('stamps envelopes with identity and correlation', async () => {
    const bus = new BrainEventBus({ clock: clockAt(), source: 'test-source' });
    const envelope = await bus.publish('decision.made', { decisionId: 'd1', selected: 'a', confidence: 1 }, {
      correlationId: 'corr-1'
    });

    assert.equal(envelope.source, 'test-source');
    assert.equal(envelope.correlationId, 'corr-1');
    assert.ok(envelope.id.startsWith('evt_'));
  });
});
