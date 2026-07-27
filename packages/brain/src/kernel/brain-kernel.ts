import {
  MemoryKeyValueStore,
  ScopedKeyValueStore,
  type HealthMonitor,
  type JsonObject,
  type KeyValueStore,
  type Logger,
  type MetricsRegistry,
  type NexusKernel
} from '@nexus/core';
import { AgentRegistry, MultiAgentRuntime } from '../agents/index.js';
import { BrainConfigurationLoader, DEFAULT_BRAIN_CONFIGURATION, type BrainConfiguration } from '../config/index.js';
import { ContextEngine, HeuristicTokenEstimator } from '../context/index.js';
import { ConversationManager } from '../conversation/index.js';
import { DecisionEngine } from '../decision/index.js';
import { BrainEventBus } from '../events/index.js';
import { KnowledgeGraph } from '../knowledge/index.js';
import {
  CachingEmbeddingProvider,
  HashEmbeddingProvider,
  InMemoryVectorMemory,
  PersistentMemoryEngine,
  type EmbeddingProvider,
  type VectorMemory
} from '../memory/index.js';
import {
  BrainMetrics,
  createAgentHealthCheck,
  createMemoryHealthCheck,
  createPluginHealthCheck,
  createSchedulerHealthCheck,
  createToolHealthCheck,
  createVectorHealthCheck
} from '../observability/index.js';
import { PlanningEngine } from '../planning/index.js';
import { PluginRegistry } from '../plugins/index.js';
import { PromptManager } from '../prompt/index.js';
import { ReasoningEngine } from '../reasoning/index.js';
import { BrainTaskScheduler } from '../scheduler/index.js';
import { SessionManager } from '../session/index.js';
import {
  ToolRegistry,
  createCalculatorTool,
  createClockTool,
  createKnowledgeQueryTool,
  createMemorySearchTool,
  createMemoryWriteTool
} from '../tools/index.js';
import { SystemClock, type Clock } from '../types/index.js';
import { WorkflowEngine } from '../workflow/index.js';

/** Every service the brain layer exposes. */
export interface BrainServices {
  readonly configuration: BrainConfiguration;
  readonly clock: Clock;
  readonly events: BrainEventBus;
  readonly memory: PersistentMemoryEngine;
  readonly vectors: VectorMemory;
  readonly embeddings: EmbeddingProvider;
  readonly knowledge: KnowledgeGraph;
  readonly context: ContextEngine;
  readonly reasoning: ReasoningEngine;
  readonly planning: PlanningEngine;
  readonly decisions: DecisionEngine;
  readonly workflows: WorkflowEngine;
  readonly scheduler: BrainTaskScheduler;
  readonly tools: ToolRegistry;
  readonly agents: AgentRegistry;
  readonly runtime: MultiAgentRuntime;
  readonly prompts: PromptManager;
  readonly conversations: ConversationManager;
  readonly sessions: SessionManager;
  readonly plugins: PluginRegistry<BrainServices>;
  readonly metrics: BrainMetrics;
  readonly logger: Logger | undefined;
}

export interface BrainKernelOptions {
  /** Persistent backing store; defaults to an in-memory store. */
  readonly store?: KeyValueStore;
  readonly configuration?: BrainConfiguration;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly metricsRegistry?: MetricsRegistry;
  readonly vectors?: VectorMemory;
  readonly embeddings?: EmbeddingProvider;
  /** Registers the built-in tool catalogue. Defaults to true. */
  readonly installDefaultTools?: boolean;
}

/** Lifecycle state of the brain kernel. */
export type BrainKernelState = 'created' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

/**
 * Brain Kernel v2 — the Phase 2 composition root.
 *
 * The kernel owns construction order and wiring for every cognitive subsystem
 * and exposes them as one coherent surface. It layers cleanly on top of the
 * Phase 1 kernel: `attach` registers brain health checks and services with the
 * existing OS kernel without modifying it.
 */
export class BrainKernel {
  private readonly serviceContainer: BrainServices;
  private state: BrainKernelState = 'created';
  private readonly disposers: (() => void | Promise<void>)[] = [];

  public constructor(options: BrainKernelOptions = {}) {
    const configuration = options.configuration ?? DEFAULT_BRAIN_CONFIGURATION;
    const clock = options.clock ?? new SystemClock();
    const store = options.store ?? new MemoryKeyValueStore();

    const events = new BrainEventBus({ clock, source: 'nexus.brain' });
    const embeddings =
      options.embeddings ?? new CachingEmbeddingProvider(new HashEmbeddingProvider(configuration.vectors.dimensions));
    const vectors = options.vectors ?? new InMemoryVectorMemory(configuration.vectors.metric);

    const memory = new PersistentMemoryEngine({
      store: new ScopedKeyValueStore(store, 'brain'),
      clock,
      vectors,
      embeddings,
      capacityPerNamespace: configuration.memory.capacityPerNamespace
    });

    const knowledge = new KnowledgeGraph(clock);
    const context = new ContextEngine({
      budget: configuration.context.tokenBudget,
      estimator: new HeuristicTokenEstimator(configuration.context.charactersPerToken),
      memory,
      graph: knowledge
    });

    const reasoning = new ReasoningEngine({
      clock,
      maxIterations: configuration.reasoning.maxIterations,
      minConfidence: configuration.reasoning.minConfidence
    });
    const planning = new PlanningEngine({ clock, maxSteps: configuration.planning.maxSteps });
    const decisions = new DecisionEngine({ clock });
    const workflows = new WorkflowEngine({ clock, events, defaultTimeoutMs: configuration.workflow.defaultTimeoutMs });

    const metrics = new BrainMetrics(options.metricsRegistry);
    const scheduler = new BrainTaskScheduler({
      clock,
      concurrency: configuration.scheduler.concurrency,
      onDeadLetter: (job) => {
        metrics.jobsDeadLettered.increment();
        options.logger?.error('Brain job exhausted retries', undefined, { jobId: job.id, jobName: job.name });
      }
    });

    const tools = new ToolRegistry({
      clock,
      defaultTimeoutMs: configuration.tools.defaultTimeoutMs,
      maxRetries: configuration.tools.maxRetries,
      permissionResolver: (brainContext) => brainContext.principal?.roles ?? []
    });

    const agents = new AgentRegistry(clock);
    const runtime = new MultiAgentRuntime({
      registry: agents,
      tools,
      events,
      clock,
      defaultTimeoutMs: configuration.agents.defaultTimeoutMs,
      maxDelegationDepth: configuration.agents.maxDelegationDepth
    });

    const prompts = new PromptManager(clock);
    const conversations = new ConversationManager({
      store: new ScopedKeyValueStore(store, 'brain'),
      clock,
      estimator: new HeuristicTokenEstimator(configuration.context.charactersPerToken),
      compactionThreshold: configuration.conversations.compactionThreshold,
      retainRecent: configuration.conversations.retainRecent
    });
    const sessions = new SessionManager({
      store: new ScopedKeyValueStore(store, 'brain'),
      clock,
      ttlMs: configuration.sessions.ttlMs,
      idleMs: configuration.sessions.idleMs
    });

    // `services` is self-referential: plugins receive the same object they are
    // reachable from. A lazy getter resolves the cycle without any casting,
    // and the registry is constructed against this same live reference.
    let pluginRegistry: PluginRegistry<BrainServices> | undefined;
    const services: BrainServices = {
      configuration,
      clock,
      events,
      memory,
      vectors,
      embeddings,
      knowledge,
      context,
      reasoning,
      planning,
      decisions,
      workflows,
      scheduler,
      tools,
      agents,
      runtime,
      prompts,
      conversations,
      sessions,
      get plugins(): PluginRegistry<BrainServices> {
        if (pluginRegistry === undefined) {
          throw new Error('Plugin registry accessed before initialization completed');
        }
        return pluginRegistry;
      },
      metrics,
      logger: options.logger
    };

    pluginRegistry = new PluginRegistry<BrainServices>(services, clock);
    this.serviceContainer = services;

    if (options.installDefaultTools ?? true) this.installDefaultTools();
  }

  /** Every wired brain service. */
  public get services(): BrainServices {
    return this.serviceContainer;
  }

  public get currentState(): BrainKernelState {
    return this.state;
  }

  /** Loads configuration from environment values and builds a kernel. */
  public static fromEnvironment(
    source: { get(name: string): string | undefined },
    options: Omit<BrainKernelOptions, 'configuration'> = {}
  ): BrainKernel {
    return new BrainKernel({ ...options, configuration: new BrainConfigurationLoader().load(source) });
  }

  /** Starts the kernel, activating plugins and scheduling maintenance. */
  public async start(): Promise<void> {
    if (this.state === 'running') return;
    this.state = 'starting';
    try {
      await this.serviceContainer.plugins.activateAll();
      this.state = 'running';
      this.serviceContainer.logger?.info('Brain kernel started', {
        tools: this.serviceContainer.tools.list().length,
        agents: this.serviceContainer.agents.list().length
      });
    } catch (error) {
      this.state = 'failed';
      throw error;
    }
  }

  /** Stops the kernel and releases plugin resources. */
  public async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'created') {
      this.state = 'stopped';
      return;
    }
    this.state = 'stopping';
    try {
      await this.serviceContainer.plugins.deactivateAll();
      for (const dispose of this.disposers.splice(0).reverse()) await dispose();
      this.state = 'stopped';
      this.serviceContainer.logger?.info('Brain kernel stopped');
    } catch (error) {
      this.state = 'failed';
      throw error;
    }
  }

  /**
   * Integrates the brain layer with a running Phase 1 kernel.
   *
   * Health checks and service-registry entries are added; no Phase 1 component
   * is modified or replaced.
   */
  public attach(kernel: NexusKernel): void {
    this.registerHealthChecks(kernel.health);
    kernel.services.register('brain', this.serviceContainer, ['brain', 'cognition']);
    kernel.services.register('brain.memory', this.serviceContainer.memory, ['brain']);
    kernel.services.register('brain.agents', this.serviceContainer.agents, ['brain']);
    kernel.services.register('brain.tools', this.serviceContainer.tools, ['brain']);
    kernel.services.register('brain.workflows', this.serviceContainer.workflows, ['brain']);

    kernel.lifecycle.register({
      id: 'nexus.brain',
      priority: 50,
      onReady: async () => {
        await this.start();
      },
      onShutdown: async () => {
        await this.stop();
      }
    });
  }

  /** Registers every brain health check with a health monitor. */
  public registerHealthChecks(health: HealthMonitor): void {
    health.register(createMemoryHealthCheck(this.serviceContainer.memory));
    health.register(createAgentHealthCheck(this.serviceContainer.agents));
    health.register(createToolHealthCheck(this.serviceContainer.tools));
    health.register(createSchedulerHealthCheck(this.serviceContainer.scheduler));
    health.register(createPluginHealthCheck(this.serviceContainer.plugins));
    health.register(createVectorHealthCheck(this.serviceContainer.vectors));
  }

  /** Non-secret operational snapshot suitable for an API response. */
  public describe(): JsonObject {
    const { tools, agents, workflows, plugins, knowledge, scheduler } = this.serviceContainer;
    return {
      state: this.state,
      tools: tools.list().length,
      agents: agents.list().length,
      workflows: workflows.list().length,
      plugins: plugins.summary(),
      knowledge: { nodes: knowledge.nodeCount, edges: knowledge.edgeCount },
      scheduler: { pending: scheduler.size, deadLettered: scheduler.deadLetters().length },
      agentStatistics: agents.statistics()
    };
  }

  private installDefaultTools(): void {
    const { tools, memory, knowledge, clock } = this.serviceContainer;
    tools.register(createMemoryWriteTool(memory));
    tools.register(createMemorySearchTool(memory));
    tools.register(createKnowledgeQueryTool(knowledge));
    tools.register(createCalculatorTool());
    tools.register(createClockTool(() => clock.timestamp()));
  }
}
