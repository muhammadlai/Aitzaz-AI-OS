import type { HealthCheck, HealthCheckResult } from '@nexus/core';
import type { AgentRegistry } from '../agents/index.js';
import type { PersistentMemoryEngine } from '../memory/index.js';
import type { PluginRegistry } from '../plugins/index.js';
import type { BrainTaskScheduler } from '../scheduler/index.js';
import type { ToolRegistry } from '../tools/index.js';
import type { VectorMemory } from '../memory/index.js';

/** Reports whether the memory engine can read and write its namespace. */
export const createMemoryHealthCheck = (memory: PersistentMemoryEngine, namespace = 'health'): HealthCheck => ({
  name: 'brain.memory',
  timeoutMs: 2_000,
  check: async (): Promise<HealthCheckResult> => {
    const probe = await memory.remember({
      namespace,
      kind: 'working',
      content: 'health probe',
      importance: 0,
      ttlMs: 1_000
    });
    const read = await memory.recall(namespace, probe.id);
    await memory.forget(namespace, probe.id);
    const statistics = await memory.statistics(namespace);
    return read === undefined
      ? { status: 'unhealthy', message: 'Memory write succeeded but recall returned nothing' }
      : { status: 'healthy', details: { namespace, records: statistics.total } };
  }
});

/** Reports agent availability; no idle agents is a degraded rather than failed state. */
export const createAgentHealthCheck = (registry: AgentRegistry): HealthCheck => ({
  name: 'brain.agents',
  check: (): HealthCheckResult => {
    const records = registry.list();
    const available = records.filter((record) => record.status === 'idle' || record.status === 'busy').length;
    const failed = records.filter((record) => record.status === 'failed').length;
    const status = records.length === 0 ? 'degraded' : failed === records.length ? 'unhealthy' : available === 0 ? 'degraded' : 'healthy';
    return {
      status,
      ...(records.length === 0 ? { message: 'No agents are registered' } : {}),
      details: { total: records.length, available, failed }
    };
  }
});

/** Reports the size of the tool catalogue. */
export const createToolHealthCheck = (tools: ToolRegistry): HealthCheck => ({
  name: 'brain.tools',
  check: (): HealthCheckResult => {
    const count = tools.list().length;
    return count === 0
      ? { status: 'degraded', message: 'No tools are registered', details: { total: 0 } }
      : { status: 'healthy', details: { total: count } };
  }
});

/** Reports scheduler backlog and dead-letter pressure. */
export const createSchedulerHealthCheck = (scheduler: BrainTaskScheduler, backlogLimit = 1_000): HealthCheck => ({
  name: 'brain.scheduler',
  check: (): HealthCheckResult => {
    const pending = scheduler.size;
    const dead = scheduler.deadLetters().length;
    const status = pending > backlogLimit ? 'degraded' : 'healthy';
    return {
      status,
      ...(status === 'degraded' ? { message: `Job backlog of ${pending} exceeds ${backlogLimit}` } : {}),
      details: { pending, deadLettered: dead }
    };
  }
});

/** Reports plugin activation failures. */
export const createPluginHealthCheck = (plugins: PluginRegistry<unknown>): HealthCheck => ({
  name: 'brain.plugins',
  check: (): HealthCheckResult => {
    const statuses = plugins.statuses();
    const failed = statuses.filter((status) => status.state === 'failed');
    return failed.length === 0
      ? { status: 'healthy', details: { total: statuses.length, active: statuses.filter((s) => s.state === 'active').length } }
      : {
          status: 'degraded',
          message: `Failed plugins: ${failed.map((status) => status.id).join(', ')}`,
          details: { total: statuses.length, failed: failed.length }
        };
  }
});

/** Reports vector index reachability and size. */
export const createVectorHealthCheck = (vectors: VectorMemory): HealthCheck => ({
  name: 'brain.vectors',
  timeoutMs: 2_000,
  check: async (): Promise<HealthCheckResult> => ({
    status: 'healthy',
    details: { entries: await vectors.size() }
  })
});
