import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import {
  asNexusError,
  NexusError,
  AuthenticationService,
  HmacJwtVerifier,
  type NexusKernel
} from '@nexus/core';

export interface ApiOptions {
  readonly kernel: NexusKernel;
  readonly authSecret?: string;
}

const requestId = (): string => crypto.randomUUID();

export const createApi = ({ kernel, authSecret }: ApiOptions): Express => {
  const app = express();
  const allowedOrigins = new Set(kernel.config.api.corsOrigins);
  const auth = authSecret === undefined || authSecret === '' ? undefined : new AuthenticationService(new HmacJwtVerifier(authSecret, kernel.config.auth));

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb', strict: true }));
  app.use((request: Request, response: Response, next: NextFunction) => {
    const origin = request.header('origin');
    if (origin !== undefined && allowedOrigins.has(origin)) response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Request-Id');
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (request.method === 'OPTIONS') { response.status(204).end(); return; }
    response.locals.requestId = request.header('x-request-id') || requestId();
    response.setHeader('X-Request-Id', response.locals.requestId as string);
    next();
  });

  app.get('/health', async (_request, response, next) => {
    try {
      const report = await kernel.health.inspect();
      response.status(report.status === 'unhealthy' ? 503 : 200).json(report);
    } catch (error) { next(error); }
  });

  app.get('/v1/system', (_request, response) => {
    response.json({
      application: kernel.config.applicationName,
      environment: kernel.config.environment,
      runtime: kernel.runtime.currentState,
      features: kernel.featureFlags.entries(),
      services: kernel.services.list().map(({ id, tags, registeredAt }) => ({ id, tags, registeredAt: registeredAt.toISOString() }))
    });
  });

  app.get('/v1/metrics', (_request, response) => { response.json({ metrics: kernel.metrics.snapshot() }); });

  app.get('/v1/identity', async (request, response, next) => {
    try {
      if (auth === undefined) {
        response.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Authentication is not configured' } });
        return;
      }
      const principal = await auth.authenticateHeader(request.header('authorization'));
      response.json({ principal });
    } catch (error) { next(error); }
  });

  app.use((_request: Request, _response: Response, next: NextFunction) => next(new NexusError('NOT_FOUND', 'Route not found')));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const nexusError = asNexusError(error);
    kernel.logger.error('API request failed', nexusError, { code: nexusError.code, requestId: response.locals.requestId as string });
    response.status(nexusError.statusCode).json({ error: { code: nexusError.code, message: nexusError.message }, requestId: response.locals.requestId });
  });
  return app;
};
