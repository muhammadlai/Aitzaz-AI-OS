import { createId, type JsonObject } from '@nexus/core';
import { duplicate, invalidArgument, notFound } from '../errors/index.js';
import { SystemClock, type Clock } from '../types/index.js';
import type { Agent, AgentRecord, AgentStatus, AgentTask, Capability } from './agent-types.js';

interface MutableRecord {
  readonly agent: Agent;
  status: AgentStatus;
  activeTasks: number;
  completedTasks: number;
  failedTasks: number;
  readonly registeredAt: string;
  lastError?: string;
}

/**
 * Directory of available agents.
 *
 * The registry owns capability matching and concurrency accounting; it does not
 * execute anything itself, which keeps selection policy separate from the
 * runtime that performs the work.
 */
export class AgentRegistry {
  private readonly agents = new Map<string, MutableRecord>();
  private readonly clock: Clock;

  public constructor(clock: Clock = new SystemClock()) {
    this.clock = clock;
  }

  /** Registers an agent, rejecting duplicates and malformed manifests. */
  public register(agent: Agent): AgentRecord {
    const { manifest } = agent;
    if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(manifest.id)) {
      throw invalidArgument(`Invalid agent id "${manifest.id}"`);
    }
    if (manifest.capabilities.length === 0) {
      throw invalidArgument(`Agent "${manifest.id}" must declare at least one capability`);
    }
    if (this.agents.has(manifest.id)) throw duplicate('Agent', manifest.id);
    if (manifest.maxConcurrency !== undefined && (!Number.isInteger(manifest.maxConcurrency) || manifest.maxConcurrency < 1)) {
      throw invalidArgument(`Agent "${manifest.id}" maxConcurrency must be a positive integer`);
    }

    const record: MutableRecord = {
      agent,
      status: 'idle',
      activeTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      registeredAt: this.clock.timestamp()
    };
    this.agents.set(manifest.id, record);
    return this.toPublic(manifest.id, record);
  }

  public unregister(id: string): boolean {
    return this.agents.delete(id);
  }

  public has(id: string): boolean {
    return this.agents.has(id);
  }

  public getAgent(id: string): Agent {
    const record = this.agents.get(id);
    if (record === undefined) throw notFound('Agent', id);
    return record.agent;
  }

  public getRecord(id: string): AgentRecord {
    const record = this.agents.get(id);
    if (record === undefined) throw notFound('Agent', id);
    return this.toPublic(id, record);
  }

  public list(): readonly AgentRecord[] {
    return [...this.agents.entries()].map(([id, record]) => this.toPublic(id, record));
  }

  /** Agents advertising every requested capability. */
  public findByCapabilities(capabilities: readonly Capability[]): readonly AgentRecord[] {
    return this.list().filter((record) =>
      capabilities.every((capability) => record.manifest.capabilities.includes(capability))
    );
  }

  /**
   * Chooses the best agent for a task.
   *
   * Candidates must satisfy every required capability and have spare capacity;
   * the least-loaded agent wins, with the most specialised manifest breaking
   * ties so general-purpose agents stay free for unmatched work.
   */
  public select(task: Pick<AgentTask, 'requiredCapabilities'>): AgentRecord | undefined {
    const candidates = this.list().filter((record) => {
      if (record.status === 'disabled' || record.status === 'failed') return false;
      if (!task.requiredCapabilities.every((capability) => record.manifest.capabilities.includes(capability))) return false;
      const limit = record.manifest.maxConcurrency ?? 1;
      return record.activeTasks < limit;
    });

    return candidates.sort((left, right) => {
      if (left.activeTasks !== right.activeTasks) return left.activeTasks - right.activeTasks;
      if (left.manifest.capabilities.length !== right.manifest.capabilities.length) {
        return left.manifest.capabilities.length - right.manifest.capabilities.length;
      }
      return left.manifest.id.localeCompare(right.manifest.id);
    })[0];
  }

  /** Marks an agent as having started a task. */
  public acquire(id: string): void {
    const record = this.mutable(id);
    const limit = record.agent.manifest.maxConcurrency ?? 1;
    if (record.activeTasks >= limit) {
      throw invalidArgument(`Agent "${id}" is at its concurrency limit of ${limit}`);
    }
    record.activeTasks += 1;
    record.status = 'busy';
  }

  /** Records completion of a task and restores availability. */
  public release(id: string, success: boolean, error?: string): void {
    const record = this.mutable(id);
    record.activeTasks = Math.max(0, record.activeTasks - 1);
    if (success) {
      record.completedTasks += 1;
      delete record.lastError;
    } else {
      record.failedTasks += 1;
      if (error !== undefined) record.lastError = error;
    }
    if (record.status !== 'disabled') {
      record.status = record.activeTasks > 0 ? 'busy' : 'idle';
    }
  }

  /** Prevents an agent from receiving further work. */
  public disable(id: string, reason?: string): void {
    const record = this.mutable(id);
    record.status = 'disabled';
    if (reason !== undefined) record.lastError = reason;
  }

  /** Returns a disabled agent to service. */
  public enable(id: string): void {
    const record = this.mutable(id);
    record.status = record.activeTasks > 0 ? 'busy' : 'idle';
    delete record.lastError;
  }

  /** Aggregate view used by health checks and dashboards. */
  public statistics(): JsonObject {
    const records = this.list();
    return {
      total: records.length,
      idle: records.filter((record) => record.status === 'idle').length,
      busy: records.filter((record) => record.status === 'busy').length,
      disabled: records.filter((record) => record.status === 'disabled').length,
      completedTasks: records.reduce((sum, record) => sum + record.completedTasks, 0),
      failedTasks: records.reduce((sum, record) => sum + record.failedTasks, 0)
    };
  }

  /** Creates a well-formed task with generated identity fields. */
  public static task(input: {
    readonly goal: string;
    readonly input?: JsonObject;
    readonly requiredCapabilities?: readonly Capability[];
    readonly priority?: number;
    readonly metadata?: JsonObject;
  }): AgentTask {
    return {
      id: createId('task'),
      goal: input.goal,
      input: input.input ?? {},
      requiredCapabilities: input.requiredCapabilities ?? [],
      priority: input.priority ?? 0,
      createdAt: new Date().toISOString(),
      metadata: input.metadata ?? {}
    };
  }

  private mutable(id: string): MutableRecord {
    const record = this.agents.get(id);
    if (record === undefined) throw notFound('Agent', id);
    return record;
  }

  private toPublic(id: string, record: MutableRecord): AgentRecord {
    return Object.freeze({
      manifest: record.agent.manifest,
      status: record.status,
      activeTasks: record.activeTasks,
      completedTasks: record.completedTasks,
      failedTasks: record.failedTasks,
      registeredAt: record.registeredAt,
      ...(record.lastError === undefined ? {} : { lastError: record.lastError })
    });
  }
}
