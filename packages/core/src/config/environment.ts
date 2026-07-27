import { DEFAULT_API_PORT, DEFAULT_LOG_LEVEL } from '../constants/index.js';
import { NexusError } from '../errors/index.js';
import type { EnvironmentName, LogLevel, NexusConfiguration } from '../types/index.js';
import { deepFreeze, parseBoolean, parseCommaList, parseInteger } from '../utils/index.js';

export interface EnvironmentSource { get(name: string): string | undefined; }
export type EnvironmentValues = Readonly<Record<string, string | undefined>>;

export class RecordEnvironmentSource implements EnvironmentSource {
  public constructor(private readonly values: EnvironmentValues) {}
  public get(name: string): string | undefined { return this.values[name]; }
}

const environments = new Set<EnvironmentName>(['development', 'test', 'staging', 'production']);
const levels = new Set<LogLevel>(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

const requiredUrl = (source: EnvironmentSource, name: string): string | undefined => {
  const value = source.get(name)?.trim();
  if (value === undefined || value === '') return undefined;
  try { new URL(value); return value; }
  catch { throw new NexusError('CONFIGURATION_INVALID', `${name} must be an absolute URL`); }
};

export class EnvironmentLoader {
  public load(source: EnvironmentSource): NexusConfiguration {
    const requestedEnvironment = source.get('NEXUS_ENVIRONMENT')?.trim() || 'development';
    if (!environments.has(requestedEnvironment as EnvironmentName)) {
      throw new NexusError('CONFIGURATION_INVALID', 'NEXUS_ENVIRONMENT must be development, test, staging, or production');
    }
    const requestedLevel = source.get('NEXUS_LOG_LEVEL')?.trim() || DEFAULT_LOG_LEVEL;
    if (!levels.has(requestedLevel as LogLevel)) {
      throw new NexusError('CONFIGURATION_INVALID', 'NEXUS_LOG_LEVEL is not a supported log level');
    }
    const applicationName = source.get('NEXUS_APPLICATION_NAME')?.trim() || 'nexus-ai-os';
    if (!/^[a-z][a-z0-9-]{1,62}$/.test(applicationName)) {
      throw new NexusError('CONFIGURATION_INVALID', 'NEXUS_APPLICATION_NAME must be a lowercase DNS-safe name');
    }
    const flags = Object.fromEntries(parseCommaList(source.get('NEXUS_FEATURES')).map((flag) => {
      const [name, rawState] = flag.split('=', 2);
      if (name === undefined || !/^[a-z][a-z0-9._-]*$/i.test(name)) {
        throw new NexusError('CONFIGURATION_INVALID', `Invalid feature flag declaration: ${flag}`);
      }
      return [name, parseBoolean(rawState, true)];
    }));
    const corsOrigins = parseCommaList(source.get('NEXUS_CORS_ORIGINS'));
    for (const origin of corsOrigins) {
      try { const parsed = new URL(origin); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); }
      catch { throw new NexusError('CONFIGURATION_INVALID', `NEXUS_CORS_ORIGINS contains an invalid origin: ${origin}`); }
    }
    const issuer = requiredUrl(source, 'NEXUS_AUTH_ISSUER');
    const audience = source.get('NEXUS_AUTH_AUDIENCE')?.trim() || undefined;
    return deepFreeze({
      environment: requestedEnvironment as EnvironmentName,
      applicationName,
      logLevel: requestedLevel as LogLevel,
      featureFlags: flags,
      api: {
        host: source.get('NEXUS_API_HOST')?.trim() || '0.0.0.0',
        port: parseInteger(source.get('NEXUS_API_PORT'), DEFAULT_API_PORT, 'NEXUS_API_PORT', [1, 65535]),
        corsOrigins
      },
      auth: { ...(issuer === undefined ? {} : { issuer }), ...(audience === undefined ? {} : { audience }) },
      telemetry: {
        enabled: parseBoolean(source.get('NEXUS_TELEMETRY_ENABLED'), true),
        serviceName: source.get('NEXUS_TELEMETRY_SERVICE_NAME')?.trim() || applicationName
      }
    });
  }
}
