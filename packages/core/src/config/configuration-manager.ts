import { NexusError } from '../errors/index.js';
import type { NexusConfiguration, Subscription } from '../types/index.js';
import { deepFreeze } from '../utils/index.js';

export type ConfigurationListener = (current: Readonly<NexusConfiguration>, previous: Readonly<NexusConfiguration>) => void | Promise<void>;

/** Maintains immutable configuration snapshots and atomically notifies subscribers. */
export class ConfigurationManager {
  private configuration: Readonly<NexusConfiguration>;
  private readonly listeners = new Set<ConfigurationListener>();

  public constructor(initialConfiguration: NexusConfiguration) { this.configuration = deepFreeze(structuredClone(initialConfiguration)); }
  public get current(): Readonly<NexusConfiguration> { return this.configuration; }

  public subscribe(listener: ConfigurationListener): Subscription {
    this.listeners.add(listener);
    let closed = false;
    return {
      get closed(): boolean { return closed; },
      dispose: () => { closed = true; this.listeners.delete(listener); }
    };
  }

  public async replace(next: NexusConfiguration): Promise<void> {
    this.validateImmutableFields(next);
    const previous = this.configuration;
    const snapshot = deepFreeze(structuredClone(next));
    this.configuration = snapshot;
    try { await Promise.all([...this.listeners].map((listener) => listener(snapshot, previous))); }
    catch (error) { this.configuration = previous; throw error; }
  }

  private validateImmutableFields(next: NexusConfiguration): void {
    if (next.applicationName !== this.configuration.applicationName) {
      throw new NexusError('INVALID_STATE', 'applicationName cannot change after runtime creation');
    }
    if (next.environment !== this.configuration.environment) {
      throw new NexusError('INVALID_STATE', 'environment cannot change after runtime creation');
    }
  }
}
