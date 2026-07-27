import { NexusError } from '../errors/index.js';
import type { Subscription } from '../types/index.js';
import { assertSafeIdentifier } from '../utils/index.js';

export interface FeatureFlagChange { readonly name: string; readonly enabled: boolean; readonly previous: boolean; }
export type FeatureFlagListener = (change: FeatureFlagChange) => void | Promise<void>;

export class FeatureFlags {
  private readonly values = new Map<string, boolean>();
  private readonly listeners = new Set<FeatureFlagListener>();

  public constructor(initial: Readonly<Record<string, boolean>> = {}) { for (const [name, enabled] of Object.entries(initial)) this.values.set(name, enabled); }
  public isEnabled(name: string): boolean { return this.values.get(name) ?? false; }
  public require(name: string): void { if (!this.isEnabled(name)) throw new NexusError('FEATURE_DISABLED', `Feature "${name}" is disabled`); }
  public entries(): Readonly<Record<string, boolean>> { return Object.freeze(Object.fromEntries(this.values)); }

  public set(name: string, enabled: boolean): void {
    assertSafeIdentifier(name, 'feature flag name');
    const previous = this.values.get(name) ?? false;
    if (previous === enabled) return;
    this.values.set(name, enabled);
    const change: FeatureFlagChange = Object.freeze({ name, enabled, previous });
    for (const listener of this.listeners) void Promise.resolve(listener(change)).catch(() => undefined);
  }

  public subscribe(listener: FeatureFlagListener): Subscription {
    this.listeners.add(listener);
    let closed = false;
    return { get closed(): boolean { return closed; }, dispose: () => { closed = true; this.listeners.delete(listener); } };
  }
}
