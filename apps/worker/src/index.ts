import { RecordEnvironmentSource, StartupBootstrap, type BootstrappedNexus } from '@nexus/core';

interface Env extends Record<string, string | undefined> {
  readonly NEXUS_ENVIRONMENT?: string;
  readonly NEXUS_LOG_LEVEL?: string;
  readonly NEXUS_APPLICATION_NAME?: string;
  readonly NEXUS_FEATURES?: string;
  readonly NEXUS_CORS_ORIGINS?: string;
  readonly NEXUS_TELEMETRY_ENABLED?: string;
  readonly NEXUS_TELEMETRY_SERVICE_NAME?: string;
  readonly NEXUS_AUTH_ISSUER?: string;
  readonly NEXUS_AUTH_AUDIENCE?: string;
}

let nexus: Promise<BootstrappedNexus> | undefined;
const bootstrap = (environment: Env): Promise<BootstrappedNexus> => {
  nexus ??= new StartupBootstrap().boot({ environment: new RecordEnvironmentSource(environment) });
  return nexus;
};
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export default {
  async fetch(request: Request, environment: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'GET') return json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404);
    const { kernel } = await bootstrap(environment);
    if (url.pathname === '/') {
      return json({
        application: kernel.config.applicationName,
        environment: kernel.config.environment,
        runtime: kernel.runtime.currentState
      });
    }
    if (url.pathname === '/health') {
      const report = await kernel.health.inspect();
      return json(report, report.status === 'unhealthy' ? 503 : 200);
    }
    if (url.pathname === '/v1/system') return json({ application: kernel.config.applicationName, environment: kernel.config.environment, runtime: kernel.runtime.currentState, features: kernel.featureFlags.entries() });
    return json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404);
  }
} satisfies ExportedHandler<Env>;
