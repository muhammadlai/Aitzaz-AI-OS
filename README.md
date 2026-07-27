# Nexus AI OS

Nexus AI OS is a TypeScript-first foundation for an AI operating system. Phase 1 establishes an executable kernel with lifecycle control, service composition, observability, secure primitives, and deployment surfaces for browser, Node/Express, and Cloudflare Workers.

## Architecture

```text
apps/
  api/       Express 5 control-plane API
  web/       React 19 + Vite + Tailwind control-plane dashboard
  worker/    Cloudflare Worker edge health and system endpoint
packages/
  core/      Runtime kernel and platform foundations
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
```

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
```

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

- `GET /health` returns aggregate health and a `503` only when unhealthy.
- `GET /v1/system` returns non-secret runtime state and service metadata.
- `GET /v1/metrics` returns metrics snapshots.
- `GET /v1/identity` validates an HS256 bearer JWT when `NEXUS_AUTH_SECRET` is configured.

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
