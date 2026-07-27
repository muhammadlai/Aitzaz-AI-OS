import { NexusError } from '../errors/index.js';
import { EventBus } from '../events/index.js';
import { LifecycleManager } from '../lifecycle/index.js';
import type { RuntimeState } from '../types/index.js';

export interface RuntimeEvents {
  stateChanged: { readonly previous: RuntimeState; readonly current: RuntimeState };
  failed: { readonly error: unknown };
}

export class RuntimeManager {
  private state: RuntimeState = 'created';
  public readonly events = new EventBus<RuntimeEvents>();

  public constructor(private readonly lifecycle: LifecycleManager) {}
  public get currentState(): RuntimeState { return this.state; }

  public async start(signal?: AbortSignal): Promise<void> {
    if (this.state === 'running') return;
    if (this.state !== 'created') throw new NexusError('INVALID_STATE', `Runtime cannot start from ${this.state}`);
    await this.transition('starting');
    try { await this.lifecycle.executeStartup(signal); await this.transition('running'); }
    catch (error) { await this.transition('failed'); await this.events.emit('failed', { error }).catch(() => undefined); throw error; }
  }

  public async stop(signal?: AbortSignal): Promise<void> {
    if (this.state === 'stopped' || this.state === 'created') { if (this.state === 'created') await this.transition('stopped'); return; }
    if (this.state !== 'running' && this.state !== 'failed') throw new NexusError('INVALID_STATE', `Runtime cannot stop from ${this.state}`);
    await this.transition('stopping');
    try { await this.lifecycle.executeShutdown(signal); await this.transition('stopped'); }
    catch (error) { await this.transition('failed'); throw error; }
  }

  private async transition(current: RuntimeState): Promise<void> {
    const previous = this.state;
    this.state = current;
    await this.events.emit('stateChanged', { previous, current });
  }
}
