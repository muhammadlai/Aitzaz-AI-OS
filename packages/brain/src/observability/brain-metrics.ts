import { MetricsRegistry, type Counter, type Histogram, type Logger, type MetricSnapshot } from '@nexus/core';

/** Latency buckets in milliseconds, spanning cache hits to long agent runs. */
const LATENCY_BUCKETS: readonly number[] = [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000];

/**
 * Metric instruments covering every brain subsystem.
 *
 * Instruments are created once and reused. The Phase 1 `MetricsRegistry`
 * rejects duplicate names, so a dedicated registry is created by default to
 * guarantee the brain layer never collides with kernel metric names.
 */
export class BrainMetrics {
  public readonly registry: MetricsRegistry;

  public readonly memoryWrites: Counter;
  public readonly memoryReads: Counter;
  public readonly memoryEvictions: Counter;
  public readonly toolInvocations: Counter;
  public readonly toolFailures: Counter;
  public readonly toolLatency: Histogram;
  public readonly agentInvocations: Counter;
  public readonly agentFailures: Counter;
  public readonly agentLatency: Histogram;
  public readonly reasoningRuns: Counter;
  public readonly reasoningSteps: Histogram;
  public readonly planCreations: Counter;
  public readonly decisions: Counter;
  public readonly workflowRuns: Counter;
  public readonly workflowFailures: Counter;
  public readonly workflowLatency: Histogram;
  public readonly jobsProcessed: Counter;
  public readonly jobsDeadLettered: Counter;
  public readonly contextAssemblies: Counter;
  public readonly contextTokens: Histogram;
  public readonly sessionsCreated: Counter;
  public readonly vectorSearches: Counter;

  public constructor(registry: MetricsRegistry = new MetricsRegistry()) {
    this.registry = registry;
    this.memoryWrites = registry.counter('brain.memory.writes', 'Memories written to the persistent store');
    this.memoryReads = registry.counter('brain.memory.reads', 'Memory recall operations');
    this.memoryEvictions = registry.counter('brain.memory.evictions', 'Memories removed by consolidation');
    this.toolInvocations = registry.counter('brain.tool.invocations', 'Tool calls attempted');
    this.toolFailures = registry.counter('brain.tool.failures', 'Tool calls that failed');
    this.toolLatency = registry.histogram('brain.tool.latency', 'Tool execution latency in milliseconds', LATENCY_BUCKETS);
    this.agentInvocations = registry.counter('brain.agent.invocations', 'Agent tasks started');
    this.agentFailures = registry.counter('brain.agent.failures', 'Agent tasks that failed');
    this.agentLatency = registry.histogram('brain.agent.latency', 'Agent execution latency in milliseconds', LATENCY_BUCKETS);
    this.reasoningRuns = registry.counter('brain.reasoning.runs', 'Reasoning sessions executed');
    this.reasoningSteps = registry.histogram('brain.reasoning.steps', 'Inference steps per reasoning run', [1, 2, 5, 10, 25, 50, 100]);
    this.planCreations = registry.counter('brain.planning.plans', 'Plans compiled');
    this.decisions = registry.counter('brain.decision.count', 'Decisions evaluated');
    this.workflowRuns = registry.counter('brain.workflow.runs', 'Workflow runs started');
    this.workflowFailures = registry.counter('brain.workflow.failures', 'Workflow runs that failed');
    this.workflowLatency = registry.histogram('brain.workflow.latency', 'Workflow duration in milliseconds', LATENCY_BUCKETS);
    this.jobsProcessed = registry.counter('brain.scheduler.jobs', 'Scheduler jobs that reached a terminal state');
    this.jobsDeadLettered = registry.counter('brain.scheduler.dead_letters', 'Scheduler jobs that exhausted retries');
    this.contextAssemblies = registry.counter('brain.context.assemblies', 'Context windows assembled');
    this.contextTokens = registry.histogram('brain.context.tokens', 'Tokens per assembled context', [128, 512, 1_024, 2_048, 4_096, 8_192, 16_384, 32_768]);
    this.sessionsCreated = registry.counter('brain.session.created', 'Sessions opened');
    this.vectorSearches = registry.counter('brain.vector.searches', 'Vector similarity searches executed');
  }

  /** Point-in-time view of every brain metric. */
  public snapshot(): readonly MetricSnapshot[] {
    return this.registry.snapshot();
  }
}

/** Wraps a logger with brain-scoped context so records are attributable. */
export const createBrainLogger = (logger: Logger, component: string): Logger =>
  logger.child({ layer: 'brain', component });
