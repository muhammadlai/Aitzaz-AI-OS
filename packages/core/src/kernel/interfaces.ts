import type { Authorizer } from '../permissions/index.js';
import type { Cache } from '../cache/index.js';
import type { CommandRegistry } from '../commands/index.js';
import type { ConfigurationManager } from '../config/index.js';
import type { Container } from '../di/index.js';
import type { EventBus } from '../events/index.js';
import type { ExtensionManager } from '../extensions/index.js';
import type { FeatureFlags } from '../features/index.js';
import type { HealthMonitor } from '../health/index.js';
import type { HookSystem } from '../hooks/index.js';
import type { LifecycleManager } from '../lifecycle/index.js';
import type { Logger } from '../logger/index.js';
import type { MetricsRegistry } from '../metrics/index.js';
import type { PluginLoader } from '../plugins/index.js';
import type { RuntimeManager } from '../runtime/index.js';
import type { TaskScheduler } from '../scheduler/index.js';
import type { ServiceRegistry } from '../services/index.js';
import type { KeyValueStore } from '../storage/index.js';
import type { Telemetry } from '../telemetry/index.js';
import type { MaybePromise, NexusConfiguration } from '../types/index.js';

export interface KernelEvents {
  readonly booted: { readonly applicationName: string; readonly environment: string };
  readonly shuttingDown: { readonly reason: string };
  readonly shutdown: { readonly reason: string };
}

export interface NexusKernel {
  readonly configuration: ConfigurationManager;
  readonly logger: Logger;
  readonly container: Container;
  readonly events: EventBus<KernelEvents>;
  readonly runtime: RuntimeManager;
  readonly lifecycle: LifecycleManager;
  readonly services: ServiceRegistry;
  readonly plugins: PluginLoader;
  readonly extensions: ExtensionManager;
  readonly featureFlags: FeatureFlags;
  readonly telemetry: Telemetry;
  readonly metrics: MetricsRegistry;
  readonly health: HealthMonitor;
  readonly permissions: Authorizer;
  readonly storage: KeyValueStore;
  readonly cache: Cache;
  readonly scheduler: TaskScheduler;
  readonly commands: CommandRegistry;
  readonly hooks: HookSystem;
  readonly config: Readonly<NexusConfiguration>;
}

export interface KernelModule {
  readonly id: string;
  register(kernel: NexusKernel): MaybePromise<void>;
}
