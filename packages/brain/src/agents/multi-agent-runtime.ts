import { createId, type JsonObject, type JsonValue } from '@nexus/core';
import { invalidArgument, invalidState, timedOut } from '../errors/index.js';
import type { BrainEventBus } from '../events/index.js';
import type { ToolRegistry } from '../tools/index.js';
import { SystemClock, type BrainContext, type Clock } from '../types/index.js';
import { deriveContext } from '../utils/index.js';
import type { AgentRegistry } from './agent-registry.js';
import type { AgentResult, AgentRuntimeServices, AgentTask } from './agent-types.js';

/** Strategy used when several agents must cooperate on one goal. */
export type CollaborationMode = 'single' | 'sequential' | 'parallel' | 'competitive';

/** A message exchanged between agents. */
export interface AgentMessage {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly body: JsonValue;
  readonly sentAt: string;
}

/** Result of a collaborative run involving multiple agents. */
export interface CollaborationResult {
  readonly id: string;
  readonly goal: string;
  readonly mode: CollaborationMode;
  readonly results: readonly AgentResult[];
  readonly success: boolean;
  readonly output: JsonValue;
  readonly durationMs: number;
}

export interface MultiAgentRuntimeOptions {
  readonly registry: AgentRegistry;
  readonly tools: ToolRegistry;
  readonly events?: BrainEventBus;
  readonly clock?: Clock;
  readonly defaultTimeoutMs?: number;
  /** Maximum depth of nested delegation, guarding against runaway recursion. */
  readonly maxDelegationDepth?: number;
}

/**
 * Executes agent tasks and coordinates multi-agent collaboration.
 *
 * The runtime owns scheduling, timeouts, delegation depth limits, and inter-agent
 * messaging. Agents themselves remain pure task handlers, which keeps them
 * testable in isolation.
 */
export class MultiAgentRuntime {
  private readonly registry: AgentRegistry;
  private readonly tools: ToolRegistry;
  private readonly events: BrainEventBus | undefined;
  private readonly clock: Clock;
  private readonly defaultTimeoutMs: number;
  private readonly maxDelegationDepth: number;
  private readonly mailbox = new Map<string, AgentMessage[]>();

  public constructor(options: MultiAgentRuntimeOptions) {
    this.registry = options.registry;
    this.tools = options.tools;
    this.events = options.events;
    this.clock = options.clock ?? new SystemClock();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
    this.maxDelegationDepth = options.maxDelegationDepth ?? 4;
    if (!Number.isInteger(this.maxDelegationDepth) || this.maxDelegationDepth < 1) {
      throw invalidArgument('maxDelegationDepth must be a positive integer');
    }
  }

  /** Routes a task to the best-matching agent and executes it. */
  public async dispatch(task: AgentTask, context: BrainContext): Promise<AgentResult> {
    const selected = this.registry.select(task);
    if (selected === undefined) {
      throw invalidState(
        `No available agent satisfies capabilities [${task.requiredCapabilities.join(', ')}]`,
        { capabilities: [...task.requiredCapabilities] }
      );
    }
    return this.runOn(selected.manifest.id, task, context, 0);
  }

  /** Executes a task on a named agent. */
  public async run(agentId: string, task: AgentTask, context: BrainContext): Promise<AgentResult> {
    return this.runOn(agentId, task, context, 0);
  }

  /**
   * Coordinates several agents toward one goal.
   *
   * - `sequential` threads each agent's output into the next task's input.
   * - `parallel` runs every agent on the same input and returns all results.
   * - `competitive` runs in parallel and keeps the first successful result.
   */
  public async collaborate(input: {
    readonly goal: string;
    readonly agentIds: readonly string[];
    readonly mode: CollaborationMode;
    readonly payload?: JsonValue;
    readonly context: BrainContext;
    readonly metadata?: JsonObject;
  }): Promise<CollaborationResult> {
    if (input.agentIds.length === 0) throw invalidArgument('At least one agent is required to collaborate');
    const startedAt = this.clock.now();
    const id = createId('collab');
    const results: AgentResult[] = [];

    const buildTask = (payload: JsonValue): AgentTask => ({
      id: createId('task'),
      goal: input.goal,
      input: payload,
      requiredCapabilities: [],
      priority: 0,
      createdAt: this.clock.timestamp(),
      metadata: input.metadata ?? {}
    });

    let output: JsonValue = input.payload ?? {};
    let success = false;

    switch (input.mode) {
      case 'single': {
        const first = input.agentIds[0] as string;
        const result = await this.runOn(first, buildTask(output), input.context, 0);
        results.push(result);
        success = result.success;
        output = result.output;
        break;
      }
      case 'sequential': {
        success = true;
        for (const agentId of input.agentIds) {
          const result = await this.runOn(agentId, buildTask(output), input.context, 0);
          results.push(result);
          if (!result.success) {
            success = false;
            break;
          }
          output = result.output;
        }
        break;
      }
      case 'parallel': {
        const settled = await Promise.all(
          input.agentIds.map((agentId) => this.runOn(agentId, buildTask(input.payload ?? {}), input.context, 0))
        );
        results.push(...settled);
        success = settled.every((result) => result.success);
        output = settled.map((result) => result.output) as unknown as JsonValue;
        break;
      }
      case 'competitive': {
        const settled = await Promise.all(
          input.agentIds.map((agentId) => this.runOn(agentId, buildTask(input.payload ?? {}), input.context, 0))
        );
        results.push(...settled);
        const winner = settled.find((result) => result.success);
        success = winner !== undefined;
        output = winner?.output ?? {};
        break;
      }
    }

    return {
      id,
      goal: input.goal,
      mode: input.mode,
      results,
      success,
      output,
      durationMs: this.clock.now() - startedAt
    };
  }

  /** Places a message in an agent's mailbox. */
  public send(message: Omit<AgentMessage, 'id' | 'sentAt'>): AgentMessage {
    const envelope: AgentMessage = { ...message, id: createId('amsg'), sentAt: this.clock.timestamp() };
    const inbox = this.mailbox.get(message.to) ?? [];
    inbox.push(envelope);
    this.mailbox.set(message.to, inbox);
    return envelope;
  }

  /** Drains and returns an agent's pending messages. */
  public receive(agentId: string): readonly AgentMessage[] {
    const inbox = this.mailbox.get(agentId) ?? [];
    this.mailbox.set(agentId, []);
    return inbox;
  }

  /** Number of messages waiting for an agent. */
  public pendingMessages(agentId: string): number {
    return (this.mailbox.get(agentId) ?? []).length;
  }

  private async runOn(agentId: string, task: AgentTask, context: BrainContext, depth: number): Promise<AgentResult> {
    if (depth > this.maxDelegationDepth) {
      throw invalidState(`Delegation depth exceeded ${this.maxDelegationDepth}`, { agentId, depth });
    }

    const agent = this.registry.getAgent(agentId);
    const record = this.registry.getRecord(agentId);
    if (record.status === 'disabled') {
      throw invalidState(`Agent "${agentId}" is disabled`, { agentId });
    }

    this.registry.acquire(agentId);
    const startedAt = this.clock.now();
    await this.events?.publish('agent.invoked', { agentId, taskId: task.id }, { correlationId: context.correlationId });

    const services: AgentRuntimeServices = {
      tools: this.tools,
      emit: async (event, payload) => {
        await this.events?.publishCustom(event, payload, { source: agentId, correlationId: context.correlationId });
      },
      delegate: async (delegated, delegatedContext) => {
        const childTask: AgentTask = { ...delegated, id: createId('task'), createdAt: this.clock.timestamp() };
        const target = this.registry.select(childTask);
        if (target === undefined) {
          throw invalidState(
            `No available agent satisfies delegated capabilities [${childTask.requiredCapabilities.join(', ')}]`,
            { capabilities: [...childTask.requiredCapabilities] }
          );
        }
        return this.runOn(target.manifest.id, childTask, deriveContext(delegatedContext), depth + 1);
      }
    };

    const timeoutMs = agent.manifest.timeoutMs ?? this.defaultTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const result = await Promise.race([
        agent.execute(task, context, services),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(timedOut(`Agent "${agentId}"`, timeoutMs)), timeoutMs);
        })
      ]);
      this.registry.release(agentId, result.success, result.error);
      await this.events?.publish(
        'agent.completed',
        { agentId, taskId: task.id, success: result.success },
        { correlationId: context.correlationId }
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.registry.release(agentId, false, message);
      await this.events?.publish(
        'agent.completed',
        { agentId, taskId: task.id, success: false },
        { correlationId: context.correlationId }
      );
      return {
        taskId: task.id,
        agentId,
        success: false,
        output: {},
        error: message,
        durationMs: this.clock.now() - startedAt,
        toolCalls: []
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
