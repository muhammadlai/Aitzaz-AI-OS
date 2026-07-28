import { createId, type JsonObject, type JsonValue } from '@nexus/core';
import type { AgentResult, AgentTask, MultiAgentRuntime } from '../agents/index.js';
import type { BrainContext, Clock } from '../types/index.js';
import { SystemClock } from '../types/index.js';
import { createContext } from '../utils/index.js';
import type { BrainEventBus } from '../events/index.js';
import type { BrainTaskScheduler } from '../scheduler/index.js';
import { DynamicAgentLoader } from './agent-loader.js';
import { KnowledgeRetriever } from './knowledge-retriever.js';
import { RuntimeStreamHub } from './streaming.js';

export interface AutonomousRuntimeOptions {
  readonly agents: MultiAgentRuntime; readonly scheduler: BrainTaskScheduler; readonly events: BrainEventBus;
  readonly loader: DynamicAgentLoader; readonly knowledge: KnowledgeRetriever; readonly streams?: RuntimeStreamHub; readonly clock?: Clock;
}
export interface RuntimeTaskRequest { readonly goal: string; readonly input?: JsonValue; readonly capabilities?: readonly string[]; readonly priority?: number; readonly sessionId?: string; readonly conversationId?: string; readonly metadata?: JsonObject; }
export interface RuntimeTaskReceipt { readonly id: string; readonly task: AgentTask; }

/** Phase 3 composition layer: durable queue admission, agent dispatch, event audit, retrieval and live streaming. */
export class AutonomousRuntime {
  public readonly streams: RuntimeStreamHub;
  private readonly clock: Clock;
  public constructor(private readonly options: AutonomousRuntimeOptions) { this.clock = options.clock ?? new SystemClock(); this.streams = options.streams ?? new RuntimeStreamHub(); }
  public submit(request: RuntimeTaskRequest, context?: BrainContext): RuntimeTaskReceipt {
    const task: AgentTask = { id: createId('task'), goal: request.goal, input: request.input ?? {}, requiredCapabilities: request.capabilities ?? [], priority: request.priority ?? 0, createdAt: this.clock.timestamp(), metadata: request.metadata ?? {} };
    const executionContext = context ?? createContext({ correlationId: task.id, ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }), ...(request.conversationId === undefined ? {} : { conversationId: request.conversationId }) });
    this.options.scheduler.enqueue({ id: task.id, name: 'agent.dispatch', priority: task.priority, metadata: task.metadata }, async () => this.execute(task, executionContext));
    this.streams.publish('task.queued', { taskId: task.id, goal: task.goal });
    return { id: task.id, task };
  }
  public async drain(): Promise<readonly unknown[]> { return this.options.scheduler.drain(); }
  public retrieve(query: string, limit?: number) { return this.options.knowledge.search(query, limit); }
  private async execute(task: AgentTask, context: BrainContext): Promise<AgentResult> {
    this.streams.publish('task.started', { taskId: task.id });
    await this.options.events.publishCustom('runtime.task.started', { taskId: task.id, goal: task.goal }, { correlationId: context.correlationId });
    const result = await this.options.agents.dispatch(task, context);
    this.streams.publish('task.completed', { taskId: task.id, success: result.success });
    await this.options.events.publishCustom('runtime.task.completed', { taskId: task.id, success: result.success }, { correlationId: context.correlationId });
    return result;
  }
}
