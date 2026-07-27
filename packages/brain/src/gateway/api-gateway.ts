import { createId, type JsonObject, type JsonValue } from '@nexus/core';
import { duplicate, invalidArgument } from '../errors/index.js';
import { SystemClock, type BrainPrincipal, type Clock, type SchemaDescriptor } from '../types/index.js';
import { validateSchema } from '../utils/index.js';

/** HTTP-like verbs supported by the gateway. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A transport-agnostic inbound request. */
export interface GatewayRequest {
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: JsonValue;
  readonly principal?: BrainPrincipal;
  readonly receivedAt: string;
}

/** A transport-agnostic response. */
export interface GatewayResponse {
  readonly status: number;
  readonly body: JsonValue;
  readonly headers: Readonly<Record<string, string>>;
}

/** Path parameters extracted from a matched route. */
export type RouteParams = Readonly<Record<string, string>>;

/** Handler context passed to a route. */
export interface RouteContext {
  readonly request: GatewayRequest;
  readonly params: RouteParams;
  readonly correlationId: string;
}

/** A registered API route. */
export interface Route {
  readonly method: HttpMethod;
  /** Path pattern supporting `:name` segments, for example `/v2/agents/:id`. */
  readonly path: string;
  readonly description: string;
  readonly bodySchema?: SchemaDescriptor;
  readonly requiredPermissions?: readonly string[];
  /** Requests allowed per window for this route. */
  readonly rateLimit?: { readonly limit: number; readonly windowMs: number };
  handle(context: RouteContext): Promise<GatewayResponse> | GatewayResponse;
}

/** Cross-cutting behaviour applied around route handlers. */
export type Middleware = (
  context: RouteContext,
  next: () => Promise<GatewayResponse>
) => Promise<GatewayResponse>;

interface CompiledRoute {
  readonly route: Route;
  readonly segments: readonly string[];
}

interface RateWindow {
  count: number;
  resetAt: number;
}

/**
 * Transport-agnostic API gateway.
 *
 * Routing, validation, authorization, and rate limiting are resolved here so
 * the same route table can be served from Express, a Cloudflare Worker, or a
 * test harness without duplicating logic.
 */
export class ApiGateway {
  private readonly routes: CompiledRoute[] = [];
  private readonly middleware: Middleware[] = [];
  private readonly rateWindows = new Map<string, RateWindow>();
  private readonly clock: Clock;

  public constructor(clock: Clock = new SystemClock()) {
    this.clock = clock;
  }

  /** Registers a route, rejecting duplicate method and path pairs. */
  public register(route: Route): void {
    if (!route.path.startsWith('/')) throw invalidArgument(`Route path "${route.path}" must start with "/"`);
    const segments = route.path.split('/').filter((segment) => segment !== '');
    const existing = this.routes.find(
      (candidate) => candidate.route.method === route.method && candidate.route.path === route.path
    );
    if (existing !== undefined) throw duplicate('Route', `${route.method} ${route.path}`);
    this.routes.push({ route, segments });
  }

  /** Adds middleware, executed in registration order around every request. */
  public use(middleware: Middleware): void {
    this.middleware.push(middleware);
  }

  /** Registered routes, for documentation endpoints. */
  public listRoutes(): readonly { readonly method: HttpMethod; readonly path: string; readonly description: string }[] {
    return this.routes.map(({ route }) => ({ method: route.method, path: route.path, description: route.description }));
  }

  /** Resolves and executes a request through the middleware chain. */
  public async handle(request: GatewayRequest): Promise<GatewayResponse> {
    const match = this.match(request.method, request.path);
    if (match === undefined) {
      return this.error(404, 'NOT_FOUND', `No route matches ${request.method} ${request.path}`);
    }

    const { route, params } = match;
    const context: RouteContext = { request, params, correlationId: request.headers['x-correlation-id'] ?? createId('req') };

    if ((route.requiredPermissions ?? []).length > 0) {
      const held = new Set(request.principal?.roles ?? []);
      const missing = (route.requiredPermissions ?? []).filter((permission) => !held.has(permission));
      if (request.principal === undefined) {
        return this.error(401, 'AUTHENTICATION_FAILED', 'This route requires an authenticated principal');
      }
      if (missing.length > 0) {
        return this.error(403, 'AUTHORIZATION_DENIED', `Missing permission(s): ${missing.join(', ')}`);
      }
    }

    if (route.rateLimit !== undefined) {
      const key = `${route.method} ${route.path}|${request.principal?.id ?? request.headers['x-forwarded-for'] ?? 'anonymous'}`;
      const allowed = this.consumeRateLimit(key, route.rateLimit.limit, route.rateLimit.windowMs);
      if (!allowed) {
        return this.error(429, 'RATE_LIMITED', `Rate limit of ${route.rateLimit.limit} requests exceeded`);
      }
    }

    if (route.bodySchema !== undefined) {
      const validation = validateSchema(request.body, route.bodySchema);
      if (!validation.ok) {
        return this.error(400, 'INVALID_ARGUMENT', `Request body is invalid: ${validation.error.join('; ')}`);
      }
    }

    const invoke = async (): Promise<GatewayResponse> => {
      try {
        return await route.handle(context);
      } catch (error) {
        const status = this.statusFromError(error);
        return this.error(status, status === 500 ? 'INTERNAL' : 'REQUEST_FAILED', this.messageFromError(error));
      }
    };

    const chain = this.middleware.reduceRight<() => Promise<GatewayResponse>>(
      (next, middleware) => () => middleware(context, next),
      invoke
    );

    const response = await chain();
    return {
      ...response,
      headers: { 'content-type': 'application/json', 'x-correlation-id': context.correlationId, ...response.headers }
    };
  }

  /** Builds a well-formed request, filling defaults. */
  public static request(input: {
    readonly method: HttpMethod;
    readonly path: string;
    readonly body?: JsonValue;
    readonly query?: Readonly<Record<string, string>>;
    readonly headers?: Readonly<Record<string, string>>;
    readonly principal?: BrainPrincipal;
  }): GatewayRequest {
    return {
      id: createId('req'),
      method: input.method,
      path: input.path,
      query: input.query ?? {},
      headers: input.headers ?? {},
      body: input.body ?? null,
      ...(input.principal === undefined ? {} : { principal: input.principal }),
      receivedAt: new Date().toISOString()
    };
  }

  /** Convenience helper producing a JSON success response. */
  public static ok(body: JsonValue, status = 200): GatewayResponse {
    return { status, body, headers: {} };
  }

  private match(method: HttpMethod, path: string): { readonly route: Route; readonly params: RouteParams } | undefined {
    const requested = path.split('?')[0]?.split('/').filter((segment) => segment !== '') ?? [];

    for (const { route, segments } of this.routes) {
      if (route.method !== method || segments.length !== requested.length) continue;
      const params: Record<string, string> = {};
      let matched = true;

      for (let index = 0; index < segments.length; index += 1) {
        const pattern = segments[index] as string;
        const value = requested[index] as string;
        if (pattern.startsWith(':')) {
          params[pattern.slice(1)] = decodeURIComponent(value);
        } else if (pattern !== value) {
          matched = false;
          break;
        }
      }
      if (matched) return { route, params };
    }
    return undefined;
  }

  private consumeRateLimit(key: string, limit: number, windowMs: number): boolean {
    const now = this.clock.now();
    const window = this.rateWindows.get(key);
    if (window === undefined || now >= window.resetAt) {
      this.rateWindows.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (window.count >= limit) return false;
    window.count += 1;
    return true;
  }

  private statusFromError(error: unknown): number {
    if (typeof error === 'object' && error !== null && 'statusCode' in error) {
      const status = (error as { readonly statusCode: unknown }).statusCode;
      if (typeof status === 'number' && status >= 400 && status <= 599) return status;
    }
    return 500;
  }

  private messageFromError(error: unknown): string {
    return error instanceof Error ? error.message : 'An unexpected error occurred';
  }

  private error(status: number, code: string, message: string): GatewayResponse {
    const body: JsonObject = { error: { code, message } };
    return { status, body, headers: {} };
  }
}
