import { MemoryKeyValueStore } from '@nexus/core';
import type { Agent, AgentResult, AgentTask } from '../src/agents/index.js';
import { ManualClock, type BrainContext } from '../src/types/index.js';
import { createContext } from '../src/utils/index.js';

/** A deterministic clock shared by tests that assert on time. */
export const clockAt = (start = 1_700_000_000_000): ManualClock => new ManualClock(start);

/** A fresh in-memory store per test, guaranteeing isolation. */
export const freshStore = (): MemoryKeyValueStore => new MemoryKeyValueStore();

/** A ready-to-use brain context. */
export const testContext = (overrides: Parameters<typeof createContext>[0] = {}): BrainContext =>
  createContext({ correlationId: 'test-correlation', ...overrides });

/** Builds a minimal agent whose behaviour is supplied by the caller. */
export const makeAgent = (
  id: string,
  capabilities: readonly string[],
  behavior: (task: AgentTask) => Promise<Partial<AgentResult>> | Partial<AgentResult>,
  options: { readonly maxConcurrency?: number; readonly timeoutMs?: number } = {}
): Agent => ({
  manifest: {
    id,
    name: id,
    description: `Test agent ${id}`,
    capabilities,
    ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  },
  execute: async (task): Promise<AgentResult> => {
    const partial = await behavior(task);
    return {
      taskId: task.id,
      agentId: id,
      success: true,
      output: {},
      durationMs: 0,
      toolCalls: [],
      ...partial
    };
  }
});

/** Resolves after the event loop drains, for timer-based assertions. */
export const tick = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};
