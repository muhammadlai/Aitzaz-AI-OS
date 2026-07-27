import { MemoryCache } from '../cache/index.js';
import { CommandRegistry } from '../commands/index.js';
import { ConfigurationManager, EnvironmentLoader, type EnvironmentSource } from '../config/index.js';
import { Container } from '../di/index.js';
import { EventBus } from '../events/index.js';
import { ExtensionManager } from '../extensions/index.js';
import { FeatureFlags } from '../features/index.js';
import { HealthMonitor } from '../health/index.js';
import { HookSystem } from '../hooks/index.js';
import { KernelTokens, type KernelEvents, type KernelModule, type NexusKernel } from '../kernel/index.js';
import { LifecycleManager } from '../lifecycle/index.js';
import { ConsoleLogSink, StructuredLogger, type LogSink } from '../logger/index.js';
import { MetricsRegistry } from '../metrics/index.js';
import { Authorizer } from '../permissions/index.js';
import { PluginLoader } from '../plugins/index.js';
import { RuntimeManager } from '../runtime/index.js';
import { TaskScheduler } from '../scheduler/index.js';
import { ServiceRegistry } from '../services/index.js';
import { MemoryKeyValueStore, type KeyValueStore } from '../storage/index.js';
import { InMemorySpanExporter, Telemetry } from '../telemetry/index.js';
import type { NexusConfiguration } from '../types/index.js';
import { ShutdownManager } from './shutdown-manager.js';

export interface BootstrapOptions {
  readonly environment: EnvironmentSource;
  readonly modules?: readonly KernelModule[];
  readonly storage?: KeyValueStore;
  readonly logSinks?: readonly LogSink[];
}

export interface BootstrappedNexus { readonly kernel: NexusKernel; readonly shutdown: ShutdownManager; }

/** Creates and starts the platform kernel from explicit dependencies and validated environment values. */
export class StartupBootstrap {
  public async boot(options: BootstrapOptions): Promise<BootstrappedNexus> {
    const configuration = new ConfigurationManager(new EnvironmentLoader().load(options.environment));
    const logger = new StructuredLogger(configuration.current.logLevel, options.logSinks ?? [new ConsoleLogSink()], { application: configuration.current.applicationName, environment: configuration.current.environment });
    const container = new Container();
    const lifecycle = new LifecycleManager();
    const runtime = new RuntimeManager(lifecycle);
    const services = new ServiceRegistry();
    const events = new EventBus<KernelEvents>();
    const featureFlags = new FeatureFlags(configuration.current.featureFlags);
    const hooks = new HookSystem();
    const extensions = new ExtensionManager(hooks);
    const telemetry = new Telemetry(new InMemorySpanExporter(), configuration.current.telemetry.enabled);
    const metrics = new MetricsRegistry();
    const health = new HealthMonitor();
    const permissions = new Authorizer();
    const storage = options.storage ?? new MemoryKeyValueStore();
    const cache = new MemoryCache();
    const commands = new CommandRegistry();
    const scheduler = new TaskScheduler(undefined, async (failure) => logger.error('Scheduled task failed', failure.error, { taskId: failure.taskId, occurredAt: failure.occurredAt }));
    const plugins = new PluginLoader();
    const kernel: NexusKernel = {
      configuration, logger, container, events, runtime, lifecycle, services, plugins, extensions, featureFlags, telemetry, metrics, health, permissions, storage, cache, scheduler, commands, hooks,
      get config(): Readonly<NexusConfiguration> { return configuration.current; }
    };
    this.registerFoundation(kernel);
    lifecycle.register({ id: 'nexus.scheduler', priority: 100, onReady: () => scheduler.start(), onShutdown: () => scheduler.stop() });
    health.register({ name: 'runtime', check: () => ({ status: runtime.currentState === 'running' ? 'healthy' : 'unhealthy', details: { state: runtime.currentState } }) });
    health.register({ name: 'scheduler', check: () => ({ status: 'healthy', details: { taskCount: scheduler.list().length } }) });
    for (const module of options.modules ?? []) await module.register(kernel);
    await runtime.start();
    await events.emit('booted', { applicationName: configuration.current.applicationName, environment: configuration.current.environment });
    logger.info('Nexus runtime started', { version: '0.1.0' });
    return Object.freeze({ kernel, shutdown: new ShutdownManager(kernel) });
  }

  private registerFoundation(kernel: NexusKernel): void {
    const entries: readonly [string, unknown, readonly string[]][] = [
      ['configuration', kernel.configuration, ['foundation']], ['logger', kernel.logger, ['foundation']], ['events', kernel.events, ['foundation']], ['runtime', kernel.runtime, ['foundation']],
      ['services', kernel.services, ['foundation']], ['features', kernel.featureFlags, ['foundation']], ['telemetry', kernel.telemetry, ['observability']], ['metrics', kernel.metrics, ['observability']],
      ['health', kernel.health, ['observability']], ['storage', kernel.storage, ['foundation']], ['cache', kernel.cache, ['foundation']], ['commands', kernel.commands, ['foundation']], ['hooks', kernel.hooks, ['foundation']]
    ];
    for (const [id, instance, tags] of entries) kernel.services.register(id, instance, tags);
    kernel.container.register(KernelTokens.configuration, { useValue: kernel.configuration });
    kernel.container.register(KernelTokens.logger, { useValue: kernel.logger });
    kernel.container.register(KernelTokens.services, { useValue: kernel.services });
    kernel.container.register(KernelTokens.featureFlags, { useValue: kernel.featureFlags });
    kernel.container.register(KernelTokens.telemetry, { useValue: kernel.telemetry });
    kernel.container.register(KernelTokens.metrics, { useValue: kernel.metrics });
    kernel.container.register(KernelTokens.health, { useValue: kernel.health });
    kernel.container.register(KernelTokens.storage, { useValue: kernel.storage });
    kernel.container.register(KernelTokens.cache, { useValue: kernel.cache });
    kernel.container.register(KernelTokens.commands, { useValue: kernel.commands });
    kernel.container.register(KernelTokens.hooks, { useValue: kernel.hooks });
  }
}
