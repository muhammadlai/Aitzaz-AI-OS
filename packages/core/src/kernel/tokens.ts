import type { Cache } from '../cache/index.js';
import type { CommandRegistry } from '../commands/index.js';
import type { ConfigurationManager } from '../config/index.js';
import type { InjectionToken } from '../di/index.js';
import type { FeatureFlags } from '../features/index.js';
import type { HealthMonitor } from '../health/index.js';
import type { HookSystem } from '../hooks/index.js';
import type { Logger } from '../logger/index.js';
import type { MetricsRegistry } from '../metrics/index.js';
import type { ServiceRegistry } from '../services/index.js';
import type { KeyValueStore } from '../storage/index.js';
import type { Telemetry } from '../telemetry/index.js';

export const KernelTokens = {
  configuration: Symbol('nexus.configuration') as InjectionToken<ConfigurationManager>,
  logger: Symbol('nexus.logger') as InjectionToken<Logger>,
  services: Symbol('nexus.services') as InjectionToken<ServiceRegistry>,
  featureFlags: Symbol('nexus.features') as InjectionToken<FeatureFlags>,
  telemetry: Symbol('nexus.telemetry') as InjectionToken<Telemetry>,
  metrics: Symbol('nexus.metrics') as InjectionToken<MetricsRegistry>,
  health: Symbol('nexus.health') as InjectionToken<HealthMonitor>,
  storage: Symbol('nexus.storage') as InjectionToken<KeyValueStore>,
  cache: Symbol('nexus.cache') as InjectionToken<Cache>,
  commands: Symbol('nexus.commands') as InjectionToken<CommandRegistry>,
  hooks: Symbol('nexus.hooks') as InjectionToken<HookSystem>
} as const;
