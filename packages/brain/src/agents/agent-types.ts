import type { JsonObject, JsonValue } from '@nexus/core';
import type { BrainContext, SchemaDescriptor } from '../types/index.js';
import type { ToolRegistry } from '../tools/index.js';

/** Lifecycle state of a registered agent. */
export type AgentStatus = 'idle' | 'busy' | 'disabled' | 'failed';

/** A named capability an agent advertises. */
export type Capability = string;

/** Work handed to an agent. */
export interface AgentTask {
  readonly id: string;
  readonly goal: string;
  readonly input: JsonValue;
  readonly requiredCapabilities: readonly Capability[];
  readonly priority: number;
  readonly createdAt: string;
  readonly metadata: JsonObject;
}

/** The outcome an agent returns. */
export interface AgentResult {
  readonly taskId: string;
  readonly agentId: string;
  readonly success: boolean;
  readonly output: JsonValue;
  readonly reasoning?: string;
  readonly error?: string;
  readonly durationMs: number;
  readonly toolCalls: readonly string[];
}

/** Services an agent may use while executing a task. */
export interface AgentRuntimeServices {
  readonly tools: ToolRegistry;
  readonly emit: (event: string, payload: JsonObject) => Promise<void>;
  readonly delegate: (task: Omit<AgentTask, 'id' | 'createdAt'>, context: BrainContext) => Promise<AgentResult>;
}

/** Descriptive metadata about an agent. */
export interface AgentManifest {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly capabilities: readonly Capability[];
  readonly inputSchema?: SchemaDescriptor;
  readonly maxConcurrency?: number;
  readonly timeoutMs?: number;
  readonly tags?: readonly string[];
}

/** An autonomous unit of execution. */
export interface Agent {
  readonly manifest: AgentManifest;
  execute(task: AgentTask, context: BrainContext, services: AgentRuntimeServices): Promise<AgentResult>;
}

/** Runtime bookkeeping for a registered agent. */
export interface AgentRecord {
  readonly manifest: AgentManifest;
  readonly status: AgentStatus;
  readonly activeTasks: number;
  readonly completedTasks: number;
  readonly failedTasks: number;
  readonly registeredAt: string;
  readonly lastError?: string;
}
