import { NexusError } from '../errors/index.js';
import { HookSystem } from '../hooks/index.js';
import type { MaybePromise } from '../types/index.js';
import { assertSafeIdentifier } from '../utils/index.js';

export interface ExtensionContext {
  readonly extensionId: string;
  readonly hooks: HookSystem;
  registerDisposer(disposer: () => MaybePromise<void>): void;
}
export interface NexusExtension {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  install(context: ExtensionContext): MaybePromise<void>;
  uninstall?(): MaybePromise<void>;
}
interface ExtensionRecord { readonly extension: NexusExtension; readonly disposers: Array<() => MaybePromise<void>>; active: boolean; }

/** Owns extension installation and guarantees registered resources are released on uninstall or install failure. */
export class ExtensionManager {
  private readonly extensions = new Map<string, ExtensionRecord>();
  public constructor(private readonly hooks: HookSystem) {}

  public register(extension: NexusExtension): void {
    assertSafeIdentifier(extension.id, 'extension id');
    if (extension.version.trim() === '' || extension.description.trim() === '') throw new NexusError('INVALID_ARGUMENT', `Extension "${extension.id}" must declare version and description`);
    if (this.extensions.has(extension.id)) throw new NexusError('DUPLICATE_REGISTRATION', `Extension "${extension.id}" is already registered`);
    this.extensions.set(extension.id, { extension, disposers: [], active: false });
  }

  public async install(id: string): Promise<void> {
    const record = this.require(id);
    if (record.active) return;
    try {
      await record.extension.install({ extensionId: id, hooks: this.hooks, registerDisposer: (disposer) => record.disposers.push(disposer) });
      record.active = true;
    } catch (error) {
      await this.cleanup(record);
      throw new NexusError('PLUGIN_LOAD_FAILED', `Extension "${id}" failed to install`, { cause: error });
    }
  }

  public async uninstall(id: string): Promise<void> {
    const record = this.require(id);
    if (!record.active) return;
    try { await record.extension.uninstall?.(); }
    finally { await this.cleanup(record); record.active = false; }
  }

  public list(): readonly { readonly id: string; readonly version: string; readonly active: boolean }[] {
    return [...this.extensions.values()].map(({ extension, active }) => Object.freeze({ id: extension.id, version: extension.version, active }));
  }

  private require(id: string): ExtensionRecord { const record = this.extensions.get(id); if (record === undefined) throw new NexusError('NOT_FOUND', `Extension "${id}" is not registered`); return record; }
  private async cleanup(record: ExtensionRecord): Promise<void> { for (const disposer of record.disposers.splice(0).reverse()) await disposer(); }
}
