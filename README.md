# Nexus AI OS

Nexus AI OS is a TypeScript-first AI operating system.

**Phase 1** establishes an executable kernel with lifecycle control, service composition, observability, secure primitives, and deployment surfaces for browser, Node/Express, and Cloudflare Workers.

**Phase 2** adds the Brain Layer (`@nexus/brain`): persistent memory, a knowledge graph, context assembly, reasoning, planning, decisions, workflows, agents, and a tool-calling framework. Phase 2 is purely additive — it builds on Phase 1 through the public seams the kernel already exposed, and no Phase 1 source file was modified.

## Architecture

```text
apps/
  api/       Express 5 control-plane API
  web/       React 19 + Vite + Tailwind control-plane dashboard
  worker/    Cloudflare Worker edge health and system endpoint
packages/
  core/      Runtime kernel and platform foundations (Phase 1)
    auth/          bearer-token authentication and HS256 JWT verification
    bootstrap/     startup and graceful shutdown coordination
    cache/         cache contract and in-memory implementation
    commands/      validated command dispatch
    config/        validated environment loading and immutable configuration
    di/            singleton/transient dependency injection container
    encryption/    Web Crypto AES-GCM service
    events/        typed ordered event bus
    extensions/    extension installation lifecycle
    features/      runtime feature flags
    health/        bounded health checks and aggregate reports
    hooks/         priority-ordered cancellable hooks
    kernel/        kernel contract and dependency tokens
    lifecycle/     ordered bootstrap/initialize/ready/shutdown phases
    logger/        structured JSON logging and pluggable sinks
    metrics/       counters, gauges, and histograms
    permissions/   principal authorization policy
    plugins/       explicit trusted-plugin activation lifecycle
    runtime/       state machine for the OS runtime
    scheduler/     bounded task scheduler
    services/      named service discovery registry
    storage/       optimistic transactional key-value abstraction
    telemetry/     span creation and exporters
    types/         shared strict TypeScript contracts
    utils/         validation, IDs, immutable values, and async tools
  brain/     Cognitive layer (Phase 2)
    kernel/        Brain Kernel v2 composition root
    memory/        persistent memory engine and vector memory interface
    knowledge/     property graph with traversal and shortest paths
    context/       token-budgeted context assembly
    reasoning/     explainable forward-chaining inference
    planning/      goal decomposition into validated step DAGs
    decision/      multi-criteria scoring with constraints
    workflow/      orchestration with retries and compensation
    scheduler/     priority job queue with backoff and dead lettering
    events/        envelope event bus with replay
    agents/        agent registry and multi-agent runtime
    tools/         schema-validated tool calling
    gateway/       transport-agnostic API gateway and route table
    prompt/        versioned prompt templates
    conversation/  durable transcripts with compaction
    session/       sessions with sliding expiry
    plugins/       dependency-ordered plugin activation
    config/        validated immutable brain configuration
    observability/ brain metrics and health checks
```

Neither `@nexus/core` nor `@nexus/brain` imports Node-only modules, so both run in the browser, Express, and Cloudflare Workers.

`@nexus/core` does not import Node-only modules, so its foundations can execute in the browser, Express, and Cloudflare Workers. Environment values are injected through an `EnvironmentSource`; no module reads process state implicitly.

## Prerequisites

- Node.js 22+
- npm 10+

## Setup and verification

```bash
cp .env.example .env
npm install
npm run typecheck
npm run build
npm test
```

`npm test` runs the Phase 2 suite: 160 tests covering every brain subsystem.

## Local development

Start the control-plane API:

```bash
npm run dev:api
```

Start the React dashboard in another terminal:

```bash
npm run dev:web
```

The dashboard defaults to `http://localhost:8787`. Set `VITE_NEXUS_API_URL` when the API is hosted elsewhere.

For the Cloudflare edge surface:

```bash
npm run dev:worker
```

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `NEXUS_ENVIRONMENT` | `development`, `test`, `staging`, or `production` | `development` |
| `NEXUS_APPLICATION_NAME` | DNS-safe application name | `nexus-ai-os` |
| `NEXUS_LOG_LEVEL` | `trace` through `fatal` | `info` |
| `NEXUS_FEATURES` | Comma-separated flags, such as `agents=true,tools=false` | empty |
| `NEXUS_API_HOST` / `NEXUS_API_PORT` | Express bind address and port | `0.0.0.0` / `8787` |
| `NEXUS_CORS_ORIGINS` | Comma-separated allowed browser origins | empty |
| `NEXUS_AUTH_SECRET` | HS256 JWT secret; use 32+ characters | unset |
| `NEXUS_AUTH_ISSUER` / `NEXUS_AUTH_AUDIENCE` | JWT verification constraints | unset |
| `NEXUS_ENCRYPTION_KEY` | Application-provided secret for `EncryptionService.fromSecret` | unset |

Secrets are deliberately not included in the immutable runtime configuration snapshot or health response.

## API surfaces

Phase 1 control plane:

- `GET /health` returns aggregate health and a `503` only when unhealthy.
- `GET /v1/system` returns non-secret runtime state and service metadata.
- `GET /v1/metrics` returns metrics snapshots.
- `GET /v1/identity` validates an HS256 bearer JWT when `NEXUS_AUTH_SECRET` is configured.

Phase 2 brain routes are served through `createBrainGateway`, which is transport-agnostic and mountable on Express, a Worker, or a test harness. See [`packages/brain/README.md`](packages/brain/README.md) for the full route table, configuration variables, and usage examples.

## Phase 2 Brain Layer

```ts
import { MemoryKeyValueStore } from '@nexus/core';
import { BrainKernel, createContext } from '@nexus/brain';

const brain = new BrainKernel({ store: new MemoryKeyValueStore() });
await brain.start();

await brain.services.memory.remember({
  namespace: 'ops',
  kind: 'semantic',
  content: 'The deployment budget is 500 dollars'
});

const recalled = await brain.services.memory.search({ namespace: 'ops', text: 'budget' });
```

To integrate with a running Phase 1 kernel, `brain.attach(kernel)` registers brain health checks, services, and lifecycle hooks without modifying any Phase 1 component.

## Runtime guarantees

- Strict TypeScript settings, including unchecked indexed access and exact optional properties.
- Environment values are validated before startup.
- Configuration snapshots are immutable, and runtime identity fields cannot mutate.
- Lifecycle phases are ordered and shutdown runs in reverse participant priority.
- Dependency registration rejects duplicate keys and resolution detects cycles.
- Health checks are individually bounded by timeouts.
- Storage supports optimistic versions and serialized transactions.
- AES-GCM uses fresh 96-bit IVs from Web Crypto.
- Plugin modules are explicitly registered; the kernel never executes untrusted package strings.

Phase 2 adds:

- Every brain component accepts an injected clock, making expiry, backoff, and rate limiting deterministic under test.
- Memory, conversations, and sessions persist through the Phase 1 `KeyValueStore` and are namespaced to prevent key collisions.
- Tool and agent failures return structured results rather than throwing; event subscribers that throw become dead letters instead of breaking publishers.
- The calculator tool parses arithmetic with a recursive-descent parser, never `eval`, so untrusted model output cannot execute code.
- Reasoning iterations, delegation depth, plan size, token budgets, session state, retries, and queue depth are all bounded.
