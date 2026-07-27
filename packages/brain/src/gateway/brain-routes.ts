import type { JsonObject, JsonValue } from '@nexus/core';
import type { BrainServices } from '../kernel/index.js';
import { ToolRegistry } from '../tools/index.js';
import type { MemoryKind } from '../memory/index.js';
import { createContext } from '../utils/index.js';
import { ApiGateway, type GatewayResponse, type Route } from './api-gateway.js';

const object = (value: JsonValue): Readonly<Record<string, JsonValue>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Readonly<Record<string, JsonValue>>) : {};

/**
 * Builds the standard Phase 2 route table.
 *
 * Routes are intentionally read-mostly and validated; write routes require an
 * authenticated principal so the control plane is safe to expose.
 */
export const createBrainRoutes = (services: BrainServices): readonly Route[] => [
  {
    method: 'GET',
    path: '/v2/brain/status',
    description: 'Operational summary of the brain layer.',
    handle: (): GatewayResponse =>
      ApiGateway.ok({
        tools: services.tools.list().length,
        agents: services.agents.statistics(),
        workflows: services.workflows.list().length,
        plugins: services.plugins.summary(),
        knowledge: { nodes: services.knowledge.nodeCount, edges: services.knowledge.edgeCount },
        scheduler: { pending: services.scheduler.size, deadLettered: services.scheduler.deadLetters().length }
      })
  },
  {
    method: 'GET',
    path: '/v2/brain/metrics',
    description: 'Metric snapshots for every brain subsystem.',
    handle: (): GatewayResponse => ApiGateway.ok(services.metrics.snapshot() as unknown as JsonValue)
  },
  {
    method: 'GET',
    path: '/v2/tools',
    description: 'Function-calling descriptors for every registered tool.',
    handle: (): GatewayResponse => ApiGateway.ok(services.tools.describe() as unknown as JsonValue)
  },
  {
    method: 'POST',
    path: '/v2/tools/:name/invoke',
    description: 'Invoke a registered tool with validated input.',
    requiredPermissions: ['brain:tools:invoke'],
    rateLimit: { limit: 60, windowMs: 60_000 },
    bodySchema: { type: 'object', properties: { input: { type: 'object' } }, required: ['input'] },
    handle: async (routeContext): Promise<GatewayResponse> => {
      const name = routeContext.params['name'] as string;
      if (!services.tools.has(name)) {
        return { status: 404, body: { error: { code: 'NOT_FOUND', message: `Tool "${name}" is not registered` } }, headers: {} };
      }
      const body = object(routeContext.request.body);
      const call = ToolRegistry.call(name, body['input'] ?? {});
      const brainContext = createContext({
        correlationId: routeContext.correlationId,
        ...(routeContext.request.principal === undefined ? {} : { principal: routeContext.request.principal })
      });
      const result = await services.tools.invoke(call, brainContext);
      return ApiGateway.ok(result as unknown as JsonValue, result.success ? 200 : 422);
    }
  },
  {
    method: 'GET',
    path: '/v2/agents',
    description: 'List registered agents and their runtime status.',
    handle: (): GatewayResponse => ApiGateway.ok(services.agents.list() as unknown as JsonValue)
  },
  {
    method: 'POST',
    path: '/v2/agents/dispatch',
    description: 'Dispatch a task to the best-matching available agent.',
    requiredPermissions: ['brain:agents:dispatch'],
    rateLimit: { limit: 30, windowMs: 60_000 },
    bodySchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', minLength: 1 },
        input: { type: 'object' },
        capabilities: { type: 'array', items: { type: 'string' } }
      },
      required: ['goal']
    },
    handle: async (routeContext): Promise<GatewayResponse> => {
      const body = object(routeContext.request.body);
      const capabilities = Array.isArray(body['capabilities']) ? (body['capabilities'] as JsonValue[]).map(String) : [];
      const task = {
        id: routeContext.correlationId,
        goal: String(body['goal']),
        input: body['input'] ?? {},
        requiredCapabilities: capabilities,
        priority: 0,
        createdAt: services.clock.timestamp(),
        metadata: {} as JsonObject
      };
      const brainContext = createContext({
        correlationId: routeContext.correlationId,
        ...(routeContext.request.principal === undefined ? {} : { principal: routeContext.request.principal })
      });
      const result = await services.runtime.dispatch(task, brainContext);
      return ApiGateway.ok(result as unknown as JsonValue, result.success ? 200 : 422);
    }
  },
  {
    method: 'GET',
    path: '/v2/memory/:namespace',
    description: 'Search memories within a namespace.',
    handle: async (routeContext): Promise<GatewayResponse> => {
      const namespace = routeContext.params['namespace'] as string;
      const query = routeContext.request.query['q'];
      const limitRaw = routeContext.request.query['limit'];
      const records = await services.memory.search({
        namespace,
        ...(query === undefined ? {} : { text: query }),
        ...(limitRaw === undefined ? {} : { limit: Number(limitRaw) })
      });
      return ApiGateway.ok(records as unknown as JsonValue);
    }
  },
  {
    method: 'POST',
    path: '/v2/memory/:namespace',
    description: 'Persist a memory into a namespace.',
    requiredPermissions: ['brain:memory:write'],
    bodySchema: {
      type: 'object',
      properties: {
        content: { type: 'string', minLength: 1 },
        kind: { type: 'string', enum: ['episodic', 'semantic', 'procedural', 'working'] },
        importance: { type: 'number', minimum: 0, maximum: 1 },
        tags: { type: 'array', items: { type: 'string' } }
      },
      required: ['content']
    },
    handle: async (routeContext): Promise<GatewayResponse> => {
      const body = object(routeContext.request.body);
      const record = await services.memory.remember({
        namespace: routeContext.params['namespace'] as string,
        content: String(body['content']),
        kind: (body['kind'] as MemoryKind | undefined) ?? 'semantic',
        ...(typeof body['importance'] === 'number' ? { importance: body['importance'] } : {}),
        ...(Array.isArray(body['tags']) ? { tags: (body['tags'] as JsonValue[]).map(String) } : {})
      });
      return ApiGateway.ok(record as unknown as JsonValue, 201);
    }
  },
  {
    method: 'GET',
    path: '/v2/knowledge/nodes',
    description: 'Query knowledge graph nodes.',
    handle: (routeContext): GatewayResponse => {
      const type = routeContext.request.query['type'];
      const nodes = services.knowledge.findNodes({ ...(type === undefined ? {} : { type }) });
      return ApiGateway.ok(nodes as unknown as JsonValue);
    }
  },
  {
    method: 'GET',
    path: '/v2/workflows',
    description: 'List registered workflow definitions.',
    handle: (): GatewayResponse =>
      ApiGateway.ok(
        services.workflows.list().map((definition) => ({
          id: definition.id,
          name: definition.name,
          description: definition.description,
          version: definition.version,
          steps: definition.steps.length
        })) as unknown as JsonValue
      )
  },
  {
    method: 'POST',
    path: '/v2/workflows/:id/execute',
    description: 'Execute a workflow definition.',
    requiredPermissions: ['brain:workflows:execute'],
    rateLimit: { limit: 20, windowMs: 60_000 },
    bodySchema: { type: 'object', properties: { input: { type: 'object' } } },
    handle: async (routeContext): Promise<GatewayResponse> => {
      const body = object(routeContext.request.body);
      const brainContext = createContext({
        correlationId: routeContext.correlationId,
        ...(routeContext.request.principal === undefined ? {} : { principal: routeContext.request.principal })
      });
      const run = await services.workflows.execute(routeContext.params['id'] as string, body['input'] ?? {}, brainContext);
      return ApiGateway.ok(run as unknown as JsonValue, run.status === 'completed' ? 200 : 422);
    }
  },
  {
    method: 'GET',
    path: '/v2/sessions',
    description: 'List active sessions.',
    requiredPermissions: ['brain:sessions:read'],
    handle: async (): Promise<GatewayResponse> => ApiGateway.ok((await services.sessions.list('active')) as unknown as JsonValue)
  },
  {
    method: 'POST',
    path: '/v2/sessions',
    description: 'Open a new session.',
    bodySchema: { type: 'object', properties: { metadata: { type: 'object' } } },
    handle: async (routeContext): Promise<GatewayResponse> => {
      const body = object(routeContext.request.body);
      const session = await services.sessions.create({
        ...(routeContext.request.principal === undefined ? {} : { principal: routeContext.request.principal }),
        ...(typeof body['metadata'] === 'object' && body['metadata'] !== null && !Array.isArray(body['metadata'])
          ? { metadata: body['metadata'] as JsonObject }
          : {})
      });
      return ApiGateway.ok(session as unknown as JsonValue, 201);
    }
  }
];

/** Creates a gateway pre-loaded with the standard brain routes. */
export const createBrainGateway = (services: BrainServices): ApiGateway => {
  const gateway = new ApiGateway(services.clock);
  for (const route of createBrainRoutes(services)) gateway.register(route);
  return gateway;
};
