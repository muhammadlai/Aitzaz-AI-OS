# @nexus/brain — Phase 2 Brain Layer

The Brain Layer adds cognition to Nexus AI OS. It sits on top of the Phase 1
kernel and turns a well-structured runtime into a system that can remember,
reason, plan, decide, and act through agents and tools.

`@nexus/brain` depends on `@nexus/core` but **no Phase 1 file was modified**.
Integration happens through the public seams Phase 1 already exposed:
`KeyValueStore`, `HealthMonitor`, `ServiceRegistry`, `LifecycleManager`, and
`MetricsRegistry`.

## Subsystems

| Module | Responsibility |
| --- | --- |
| `kernel/` | Brain Kernel v2 — composition root wiring every subsystem |
| `memory/` | Persistent memory engine, vector memory interface, embeddings |
| `knowledge/` | Property graph with traversal and weighted shortest paths |
| `context/` | Context engine assembling a token-budgeted working window |
| `reasoning/` | Forward-chaining inference with explainable traces |
| `planning/` | Goal decomposition into validated step DAGs |
| `decision/` | Multi-criteria scoring with constraints and rationale |
| `workflow/` | Durable-style orchestration with retries and compensation |
| `scheduler/` | Priority job queue with backoff and dead lettering |
| `events/` | Envelope event bus with replay and dead-letter capture |
| `agents/` | Agent registry and multi-agent runtime |
| `tools/` | Schema-validated tool calling framework |
| `gateway/` | Transport-agnostic API gateway and the Phase 2 route table |
| `prompt/` | Versioned prompt templates |
| `conversation/` | Durable transcripts with compaction |
| `session/` | Sessions with sliding expiry and bounded state |
| `plugins/` | Plugin registry with dependency-ordered activation |
| `config/` | Validated, immutable brain configuration |
| `observability/` | Brain metrics instruments and health checks |
| `types/`, `utils/`, `errors/` | Shared contracts, schema validation, vector math |

## Quick start

```ts
import { MemoryKeyValueStore } from '@nexus/core';
import { AgentRegistry, BrainKernel, ToolRegistry, createContext } from '@nexus/brain';

const brain = new BrainKernel({ store: new MemoryKeyValueStore() });
await brain.start();

const { memory, tools, agents, runtime } = brain.services;

await memory.remember({
  namespace: 'ops',
  kind: 'semantic',
  content: 'The deployment budget is 500 dollars',
  importance: 0.8
});

agents.register({
  manifest: {
    id: 'analyst',
    name: 'Budget analyst',
    description: 'Answers budget questions from memory',
    capabilities: ['analyze']
  },
  execute: async (task) => {
    const recalled = await memory.search({ namespace: 'ops', text: 'budget' });
    return {
      taskId: task.id,
      agentId: 'analyst',
      success: true,
      output: { facts: recalled.map((record) => record.content) },
      durationMs: 0,
      toolCalls: []
    };
  }
});

const result = await runtime.dispatch(
  AgentRegistry.task({ goal: 'Summarize the budget', requiredCapabilities: ['analyze'] }),
  createContext()
);

const math = await tools.invoke(ToolRegistry.call('calculator', { expression: '500 / 2' }), createContext());

await brain.stop();
```

## Attaching to the Phase 1 kernel

`attach` registers brain health checks, service-registry entries, and lifecycle
hooks on an existing kernel without altering it:

```ts
import { StartupBootstrap, RecordEnvironmentSource } from '@nexus/core';
import { BrainKernel } from '@nexus/brain';

const { kernel } = await new StartupBootstrap().boot({
  environment: new RecordEnvironmentSource(process.env)
});

const brain = new BrainKernel({ store: kernel.storage, logger: kernel.logger });
brain.attach(kernel);
```

The brain then starts during the kernel's `ready` phase and stops during
`shutdown`.

## Design decisions

- **Storage-agnostic persistence.** Memory, conversations, and sessions write
  through the Phase 1 `KeyValueStore`, so any conforming backend works. Each is
  namespaced with `ScopedKeyValueStore` to prevent key collisions.
- **No hidden ambient state.** Every component takes an injected `Clock`, which
  makes expiry, backoff, and rate limiting deterministic under test. `ManualClock`
  drives the time-sensitive suites.
- **Runs anywhere.** No Node-only imports, so the layer executes in browsers,
  Node, and Cloudflare Workers — matching the Phase 1 constraint. The default
  embedding provider hashes locally and needs no network.
- **Safe by construction.** The calculator tool uses a recursive-descent parser
  rather than `eval`, so untrusted model output can never execute code. Plugins
  are supplied as objects, never resolved from module strings.
- **Failures are values, not surprises.** Tool and agent failures return
  structured results; event subscribers that throw become dead letters rather
  than breaking publishers.
- **Bounded everything.** Iterations, delegation depth, plan size, token budgets,
  session state, retries, and queue depth all have enforced limits.

## Configuration

All values are optional and validated at load time.

| Variable | Purpose | Default |
| --- | --- | --- |
| `NEXUS_BRAIN_MEMORY_CAPACITY` | Records retained per namespace | `10000` |
| `NEXUS_BRAIN_MEMORY_CONSOLIDATION_MS` | Consolidation interval | `300000` |
| `NEXUS_BRAIN_VECTOR_DIMENSIONS` | Embedding dimensions | `128` |
| `NEXUS_BRAIN_VECTOR_METRIC` | `cosine`, `dot`, or `euclidean` | `cosine` |
| `NEXUS_BRAIN_VECTOR_TOP_K` | Default semantic search results | `5` |
| `NEXUS_BRAIN_CONTEXT_BUDGET` | Context window token budget | `8000` |
| `NEXUS_BRAIN_CHARS_PER_TOKEN` | Token estimation ratio | `4` |
| `NEXUS_BRAIN_REASONING_MAX_ITERATIONS` | Forward-chaining cap | `32` |
| `NEXUS_BRAIN_REASONING_MIN_CONFIDENCE` | Minimum derived confidence | `0.1` |
| `NEXUS_BRAIN_PLANNING_MAX_STEPS` | Maximum steps per plan | `256` |
| `NEXUS_BRAIN_AGENT_TIMEOUT_MS` | Default agent timeout | `60000` |
| `NEXUS_BRAIN_AGENT_MAX_DEPTH` | Maximum delegation depth | `4` |
| `NEXUS_BRAIN_TOOL_TIMEOUT_MS` | Default tool timeout | `30000` |
| `NEXUS_BRAIN_TOOL_MAX_RETRIES` | Retries for idempotent tools | `2` |
| `NEXUS_BRAIN_WORKFLOW_TIMEOUT_MS` | Default step timeout | `120000` |
| `NEXUS_BRAIN_SCHEDULER_CONCURRENCY` | Parallel jobs | `4` |
| `NEXUS_BRAIN_SESSION_TTL_MS` | Session lifetime | `3600000` |
| `NEXUS_BRAIN_SESSION_IDLE_MS` | Idle threshold | `300000` |
| `NEXUS_BRAIN_CONVERSATION_COMPACTION_THRESHOLD` | Messages before compaction | `50` |
| `NEXUS_BRAIN_CONVERSATION_RETAIN_RECENT` | Turns kept verbatim | `10` |

## API surface

`createBrainGateway(services)` returns a gateway preloaded with:

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/v2/brain/status` | — |
| `GET` | `/v2/brain/metrics` | — |
| `GET` | `/v2/tools` | — |
| `POST` | `/v2/tools/:name/invoke` | `brain:tools:invoke` |
| `GET` | `/v2/agents` | — |
| `POST` | `/v2/agents/dispatch` | `brain:agents:dispatch` |
| `GET` | `/v2/memory/:namespace` | — |
| `POST` | `/v2/memory/:namespace` | `brain:memory:write` |
| `GET` | `/v2/knowledge/nodes` | — |
| `GET` | `/v2/workflows` | — |
| `POST` | `/v2/workflows/:id/execute` | `brain:workflows:execute` |
| `GET` | `/v2/sessions` | `brain:sessions:read` |
| `POST` | `/v2/sessions` | — |

The gateway is transport-agnostic: the same route table serves Express, a
Worker, or a test harness.

## Verification

```bash
npm run typecheck   # source and tests, strict mode
npm run build
npm test            # 160 tests
```

## Phase 3 — Autonomous Multi-Agent Runtime

Phase 3 adds `AutonomousRuntime`, the production composition layer above the Phase 2 brain services. It accepts bounded task requests, places them in the priority task queue, dispatches them through the capability-aware multi-agent runtime, emits correlated audit events, and publishes live task lifecycle events. `KnowledgeRetriever` offers deterministic graph retrieval for planning and agent grounding.

`DynamicAgentLoader` is deliberately an explicit, in-process allow-list of trusted factories: it does **not** import arbitrary package names, paths, or URLs. `RuntimeStreamHub` is a bounded replayable stream suitable for SSE adapters and `WebSocketRuntimeBridge` accepts a minimal platform-neutral socket shape, avoiding a Node-only WebSocket dependency.

```ts
const runtime = new AutonomousRuntime({ agents, scheduler, events, loader, knowledge });
runtime.submit({ goal: 'prepare deployment', capabilities: ['planning'], sessionId: session.id });
await runtime.drain();
```

Operational guarantees: queue admission and agent concurrency remain bounded by the existing scheduler and registry; all runtime events carry the request correlation ID; stream consumer errors cannot interrupt agent execution; and agent loading requires an explicit trusted registration.
