import { NexusError } from '../errors/index.js';
import type { MaybePromise } from '../types/index.js';
import { assertSafeIdentifier } from '../utils/index.js';

export interface PluginContext {
  readonly pluginId: string;
  registerDisposer(disposer: () => MaybePromise<void>): void;
}
export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly requires?: readonly string[];
  readonly description: string;
}
export interface NexusPlugin {
  readonly manifest: PluginManifest;
  activate(context: PluginContext): MaybePromise<void>;
  deactivate?(): MaybePromise<void>;
}
export type PluginState = 'registered' | 'activating' | 'active' | 'failed';
export interface PluginStatus { readonly id: string; readonly version: string; readonly state: PluginState; readonly error?: string; }

interface PluginRecord { readonly plugin: NexusPlugin; state: PluginState; error?: string; readonly disposers: Array<() => MaybePromise<void>>; }

/** Loads explicitly trusted plugin modules. Package acquisition and trust policy stay outside the runtime. */
export class PluginLoader {
  private readonly plugins = new Map<string, PluginRecord>();

  public register(plugin: NexusPlugin): void {
    const { id, version, description } = plugin.manifest;
    assertSafeIdentifier(id, 'plugin id');
    if (version.trim() === '' || description.trim() === '') throw new NexusError('INVALID_ARGUMENT', `Plugin "${id}" must declare a version and description`);
    if (this.plugins.has(id)) throw new NexusError('DUPLICATE_REGISTRATION', `Plugin "${id}" is already registered`);
    this.plugins.set(id, { plugin, state: 'registered', disposers: [] });
  }

  public async activate(id: string): Promise<void> {
    const record = this.require(id);
    if (record.state === 'active') return;
    if (record.state === 'activating') throw new NexusError('DEPENDENCY_CYCLE', `Plugin dependency cycle detected at "${id}"`);
    if (record.state === 'failed') throw new NexusError('PLUGIN_LOAD_FAILED', `Plugin "${id}" previously failed: ${record.error ?? 'unknown error'}`);
    record.state = 'activating';
    for (const dependency of record.plugin.manifest.requires ?? []) {
      const dependencyRecord = this.require(dependency);
      if (dependencyRecord.state !== 'active') await this.activate(dependency);
    }
    try {
      await record.plugin.activate({ pluginId: id, registerDisposer: (disposer) => record.disposers.push(disposer) });
      record.state = 'active';
    } catch (error) {
      record.state = 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      await this.cleanup(record);
      throw new NexusError('PLUGIN_LOAD_FAILED', `Plugin "${id}" failed to activate`, { cause: error });
    }
  }

  public async deactivate(id: string): Promise<void> {
    const record = this.require(id);
    if (record.state !== 'active') return;
    const dependents = [...this.plugins.values()].filter((candidate) => candidate.state === 'active' && candidate.plugin.manifest.requires?.includes(id));
    if (dependents.length > 0) throw new NexusError('INVALID_STATE', `Plugin "${id}" is required by active plugins`);
    try { await record.plugin.deactivate?.(); } finally { await this.cleanup(record); record.state = 'registered'; }
  }

  public statuses(): readonly PluginStatus[] {
    return [...this.plugins.entries()].map(([id, record]) => Object.freeze({ id, version: record.plugin.manifest.version, state: record.state, ...(record.error === undefined ? {} : { error: record.error }) }));
  }

  private require(id: string): PluginRecord { const record = this.plugins.get(id); if (record === undefined) throw new NexusError('NOT_FOUND', `Plugin "${id}" is not registered`); return record; }
  private async cleanup(record: PluginRecord): Promise<void> { for (const disposer of record.disposers.splice(0).reverse()) await disposer(); }
}
