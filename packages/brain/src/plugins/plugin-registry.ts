import type { JsonObject } from '@nexus/core';
import { duplicate, invalidArgument, invalidState, notFound } from '../errors/index.js';
import { SystemClock, type Clock } from '../types/index.js';

/** Lifecycle state of a brain plugin. */
export type PluginState = 'registered' | 'activating' | 'active' | 'failed' | 'deactivated';

/** Declarative description of a plugin. */
export interface BrainPluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  /** Ids of plugins that must be active before this one activates. */
  readonly dependencies?: readonly string[];
  /** Capabilities this plugin contributes, used for discovery. */
  readonly provides?: readonly string[];
  readonly tags?: readonly string[];
}

/** Facilities a plugin receives during activation. */
export interface PluginActivationContext<TServices> {
  readonly pluginId: string;
  readonly services: TServices;
  /** Registers cleanup to run automatically on deactivation. */
  readonly onDispose: (dispose: () => void | Promise<void>) => void;
}

/** An extension unit that augments the brain layer. */
export interface BrainPlugin<TServices = unknown> {
  readonly manifest: BrainPluginManifest;
  activate(context: PluginActivationContext<TServices>): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}

/** Public status view of a registered plugin. */
export interface PluginStatusInfo {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly state: PluginState;
  readonly provides: readonly string[];
  readonly registeredAt: string;
  readonly activatedAt?: string;
  readonly error?: string;
}

interface PluginRecord<TServices> {
  readonly plugin: BrainPlugin<TServices>;
  state: PluginState;
  readonly disposers: (() => void | Promise<void>)[];
  readonly registeredAt: string;
  activatedAt?: string;
  error?: string;
}

/**
 * Registry for brain-layer plugins.
 *
 * Plugin objects are supplied directly rather than resolved from module
 * strings, so the OS never executes untrusted code paths — the same trust model
 * Phase 1 established for kernel plugins. Dependencies activate first and
 * cycles are rejected.
 */
export class PluginRegistry<TServices = unknown> {
  private readonly plugins = new Map<string, PluginRecord<TServices>>();
  private readonly clock: Clock;

  public constructor(
    private readonly services: TServices,
    clock: Clock = new SystemClock()
  ) {
    this.clock = clock;
  }

  /** Registers a plugin without activating it. */
  public register(plugin: BrainPlugin<TServices>): void {
    const { manifest } = plugin;
    if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(manifest.id)) {
      throw invalidArgument(`Invalid plugin id "${manifest.id}"`);
    }
    if (!/^\d+\.\d+\.\d+/.test(manifest.version)) {
      throw invalidArgument(`Plugin "${manifest.id}" version must be semantic (for example 1.0.0)`);
    }
    if (this.plugins.has(manifest.id)) throw duplicate('Plugin', manifest.id);

    this.plugins.set(manifest.id, {
      plugin,
      state: 'registered',
      disposers: [],
      registeredAt: this.clock.timestamp()
    });
  }

  /** Activates a plugin and, first, any dependencies it declares. */
  public async activate(id: string): Promise<void> {
    const record = this.require(id);
    if (record.state === 'active') return;
    if (record.state === 'activating') {
      throw invalidState(`Plugin dependency cycle detected at "${id}"`, { pluginId: id });
    }

    record.state = 'activating';
    try {
      for (const dependency of record.plugin.manifest.dependencies ?? []) {
        if (!this.plugins.has(dependency)) {
          throw notFound(`Plugin "${id}" dependency`, dependency);
        }
        await this.activate(dependency);
      }

      await record.plugin.activate({
        pluginId: id,
        services: this.services,
        onDispose: (dispose) => record.disposers.push(dispose)
      });

      record.state = 'active';
      record.activatedAt = this.clock.timestamp();
      delete record.error;
    } catch (error) {
      record.state = 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      await this.dispose(record);
      throw error;
    }
  }

  /** Activates every registered plugin in dependency order. */
  public async activateAll(): Promise<void> {
    for (const id of this.plugins.keys()) {
      if (this.plugins.get(id)?.state === 'registered') await this.activate(id);
    }
  }

  /** Deactivates a plugin after verifying nothing active depends on it. */
  public async deactivate(id: string): Promise<void> {
    const record = this.require(id);
    if (record.state !== 'active') return;

    const dependents = [...this.plugins.entries()].filter(
      ([candidateId, candidate]) =>
        candidateId !== id && candidate.state === 'active' && (candidate.plugin.manifest.dependencies ?? []).includes(id)
    );
    if (dependents.length > 0) {
      throw invalidState(`Plugin "${id}" is required by ${dependents.map(([key]) => key).join(', ')}`, { pluginId: id });
    }

    try {
      await record.plugin.deactivate?.();
    } finally {
      await this.dispose(record);
      record.state = 'deactivated';
      delete record.activatedAt;
    }
  }

  /** Deactivates every active plugin in reverse dependency order. */
  public async deactivateAll(): Promise<void> {
    for (const id of [...this.plugins.keys()].reverse()) {
      if (this.plugins.get(id)?.state === 'active') await this.deactivate(id);
    }
  }

  public unregister(id: string): boolean {
    const record = this.plugins.get(id);
    if (record?.state === 'active') {
      throw invalidState(`Plugin "${id}" must be deactivated before removal`, { pluginId: id });
    }
    return this.plugins.delete(id);
  }

  public has(id: string): boolean {
    return this.plugins.has(id);
  }

  public statuses(): readonly PluginStatusInfo[] {
    return [...this.plugins.entries()].map(([id, record]) =>
      Object.freeze({
        id,
        name: record.plugin.manifest.name,
        version: record.plugin.manifest.version,
        state: record.state,
        provides: record.plugin.manifest.provides ?? [],
        registeredAt: record.registeredAt,
        ...(record.activatedAt === undefined ? {} : { activatedAt: record.activatedAt }),
        ...(record.error === undefined ? {} : { error: record.error })
      })
    );
  }

  /** Active plugins advertising a capability. */
  public findByCapability(capability: string): readonly PluginStatusInfo[] {
    return this.statuses().filter((status) => status.state === 'active' && status.provides.includes(capability));
  }

  /** Aggregate counts for health reporting. */
  public summary(): JsonObject {
    const statuses = this.statuses();
    return {
      total: statuses.length,
      active: statuses.filter((status) => status.state === 'active').length,
      failed: statuses.filter((status) => status.state === 'failed').length
    };
  }

  private require(id: string): PluginRecord<TServices> {
    const record = this.plugins.get(id);
    if (record === undefined) throw notFound('Plugin', id);
    return record;
  }

  private async dispose(record: PluginRecord<TServices>): Promise<void> {
    for (const disposer of record.disposers.splice(0).reverse()) {
      try {
        await disposer();
      } catch {
        // Disposal failures must not mask the triggering error.
      }
    }
  }
}
