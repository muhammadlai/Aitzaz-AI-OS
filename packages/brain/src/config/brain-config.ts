import type { EnvironmentSource } from '@nexus/core';
import { invalidArgument } from '../errors/index.js';
import type { SimilarityMetric } from '../types/index.js';

/** Complete, immutable configuration for the brain layer. */
export interface BrainConfiguration {
  readonly memory: {
    readonly capacityPerNamespace: number;
    readonly defaultImportance: number;
    readonly consolidationIntervalMs: number;
  };
  readonly vectors: {
    readonly dimensions: number;
    readonly metric: SimilarityMetric;
    readonly defaultTopK: number;
  };
  readonly context: {
    readonly tokenBudget: number;
    readonly charactersPerToken: number;
  };
  readonly reasoning: {
    readonly maxIterations: number;
    readonly minConfidence: number;
  };
  readonly planning: {
    readonly maxSteps: number;
  };
  readonly agents: {
    readonly defaultTimeoutMs: number;
    readonly maxDelegationDepth: number;
  };
  readonly tools: {
    readonly defaultTimeoutMs: number;
    readonly maxRetries: number;
  };
  readonly workflow: {
    readonly defaultTimeoutMs: number;
  };
  readonly scheduler: {
    readonly concurrency: number;
  };
  readonly sessions: {
    readonly ttlMs: number;
    readonly idleMs: number;
  };
  readonly conversations: {
    readonly compactionThreshold: number;
    readonly retainRecent: number;
  };
}

/** Defaults chosen to be safe in constrained runtimes such as Workers. */
export const DEFAULT_BRAIN_CONFIGURATION: BrainConfiguration = Object.freeze({
  memory: { capacityPerNamespace: 10_000, defaultImportance: 0.5, consolidationIntervalMs: 300_000 },
  vectors: { dimensions: 128, metric: 'cosine' as SimilarityMetric, defaultTopK: 5 },
  context: { tokenBudget: 8_000, charactersPerToken: 4 },
  reasoning: { maxIterations: 32, minConfidence: 0.1 },
  planning: { maxSteps: 256 },
  agents: { defaultTimeoutMs: 60_000, maxDelegationDepth: 4 },
  tools: { defaultTimeoutMs: 30_000, maxRetries: 2 },
  workflow: { defaultTimeoutMs: 120_000 },
  scheduler: { concurrency: 4 },
  sessions: { ttlMs: 3_600_000, idleMs: 300_000 },
  conversations: { compactionThreshold: 50, retainRecent: 10 }
});

const METRICS = new Set<SimilarityMetric>(['cosine', 'dot', 'euclidean']);

const readInteger = (source: EnvironmentSource, name: string, fallback: number, min: number, max: number): number => {
  const raw = source.get(name)?.trim();
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw invalidArgument(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
};

const readNumber = (source: EnvironmentSource, name: string, fallback: number, min: number, max: number): number => {
  const raw = source.get(name)?.trim();
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw invalidArgument(`${name} must be a number between ${min} and ${max}`);
  }
  return parsed;
};

/**
 * Loads brain configuration from an environment source.
 *
 * Every value is validated and bounded, and the result is deeply frozen so a
 * running system cannot be mutated into an invalid state.
 */
export class BrainConfigurationLoader {
  public load(source: EnvironmentSource): BrainConfiguration {
    const defaults = DEFAULT_BRAIN_CONFIGURATION;

    const rawMetric = source.get('NEXUS_BRAIN_VECTOR_METRIC')?.trim();
    if (rawMetric !== undefined && rawMetric !== '' && !METRICS.has(rawMetric as SimilarityMetric)) {
      throw invalidArgument('NEXUS_BRAIN_VECTOR_METRIC must be cosine, dot, or euclidean');
    }

    const compactionThreshold = readInteger(
      source,
      'NEXUS_BRAIN_CONVERSATION_COMPACTION_THRESHOLD',
      defaults.conversations.compactionThreshold,
      2,
      10_000
    );
    const retainRecent = readInteger(
      source,
      'NEXUS_BRAIN_CONVERSATION_RETAIN_RECENT',
      defaults.conversations.retainRecent,
      1,
      9_999
    );
    if (retainRecent >= compactionThreshold) {
      throw invalidArgument('NEXUS_BRAIN_CONVERSATION_RETAIN_RECENT must be less than the compaction threshold');
    }

    const ttlMs = readInteger(source, 'NEXUS_BRAIN_SESSION_TTL_MS', defaults.sessions.ttlMs, 1_000, 86_400_000);
    const idleMs = readInteger(source, 'NEXUS_BRAIN_SESSION_IDLE_MS', defaults.sessions.idleMs, 1_000, 86_400_000);
    if (idleMs > ttlMs) throw invalidArgument('NEXUS_BRAIN_SESSION_IDLE_MS must not exceed the session TTL');

    return Object.freeze({
      memory: Object.freeze({
        capacityPerNamespace: readInteger(
          source,
          'NEXUS_BRAIN_MEMORY_CAPACITY',
          defaults.memory.capacityPerNamespace,
          1,
          1_000_000
        ),
        defaultImportance: readNumber(source, 'NEXUS_BRAIN_MEMORY_IMPORTANCE', defaults.memory.defaultImportance, 0, 1),
        consolidationIntervalMs: readInteger(
          source,
          'NEXUS_BRAIN_MEMORY_CONSOLIDATION_MS',
          defaults.memory.consolidationIntervalMs,
          1_000,
          86_400_000
        )
      }),
      vectors: Object.freeze({
        dimensions: readInteger(source, 'NEXUS_BRAIN_VECTOR_DIMENSIONS', defaults.vectors.dimensions, 8, 4_096),
        metric: (rawMetric === undefined || rawMetric === '' ? defaults.vectors.metric : rawMetric) as SimilarityMetric,
        defaultTopK: readInteger(source, 'NEXUS_BRAIN_VECTOR_TOP_K', defaults.vectors.defaultTopK, 1, 100)
      }),
      context: Object.freeze({
        tokenBudget: readInteger(source, 'NEXUS_BRAIN_CONTEXT_BUDGET', defaults.context.tokenBudget, 128, 1_000_000),
        charactersPerToken: readNumber(
          source,
          'NEXUS_BRAIN_CHARS_PER_TOKEN',
          defaults.context.charactersPerToken,
          1,
          20
        )
      }),
      reasoning: Object.freeze({
        maxIterations: readInteger(source, 'NEXUS_BRAIN_REASONING_MAX_ITERATIONS', defaults.reasoning.maxIterations, 1, 1_000),
        minConfidence: readNumber(source, 'NEXUS_BRAIN_REASONING_MIN_CONFIDENCE', defaults.reasoning.minConfidence, 0, 1)
      }),
      planning: Object.freeze({
        maxSteps: readInteger(source, 'NEXUS_BRAIN_PLANNING_MAX_STEPS', defaults.planning.maxSteps, 1, 10_000)
      }),
      agents: Object.freeze({
        defaultTimeoutMs: readInteger(source, 'NEXUS_BRAIN_AGENT_TIMEOUT_MS', defaults.agents.defaultTimeoutMs, 100, 3_600_000),
        maxDelegationDepth: readInteger(source, 'NEXUS_BRAIN_AGENT_MAX_DEPTH', defaults.agents.maxDelegationDepth, 1, 32)
      }),
      tools: Object.freeze({
        defaultTimeoutMs: readInteger(source, 'NEXUS_BRAIN_TOOL_TIMEOUT_MS', defaults.tools.defaultTimeoutMs, 100, 3_600_000),
        maxRetries: readInteger(source, 'NEXUS_BRAIN_TOOL_MAX_RETRIES', defaults.tools.maxRetries, 0, 10)
      }),
      workflow: Object.freeze({
        defaultTimeoutMs: readInteger(
          source,
          'NEXUS_BRAIN_WORKFLOW_TIMEOUT_MS',
          defaults.workflow.defaultTimeoutMs,
          100,
          3_600_000
        )
      }),
      scheduler: Object.freeze({
        concurrency: readInteger(source, 'NEXUS_BRAIN_SCHEDULER_CONCURRENCY', defaults.scheduler.concurrency, 1, 256)
      }),
      sessions: Object.freeze({ ttlMs, idleMs }),
      conversations: Object.freeze({ compactionThreshold, retainRecent })
    });
  }
}
