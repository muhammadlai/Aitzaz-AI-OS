import { LIFECYCLE_PHASES } from '../constants/index.js';
import { NexusError } from '../errors/index.js';
import type { LifecyclePhase, MaybePromise } from '../types/index.js';
import { assertSafeIdentifier } from '../utils/index.js';

export interface LifecycleContext { readonly phase: LifecyclePhase; readonly signal: AbortSignal; }
export interface LifecycleParticipant {
  readonly id: string;
  readonly priority?: number;
  onBootstrap?(context: LifecycleContext): MaybePromise<void>;
  onInitialize?(context: LifecycleContext): MaybePromise<void>;
  onReady?(context: LifecycleContext): MaybePromise<void>;
  onShutdown?(context: LifecycleContext): MaybePromise<void>;
}

const handlerFor = (participant: LifecycleParticipant, phase: LifecyclePhase): ((context: LifecycleContext) => MaybePromise<void>) | undefined => {
  switch (phase) {
    case 'bootstrap': return participant.onBootstrap;
    case 'initialize': return participant.onInitialize;
    case 'ready': return participant.onReady;
    case 'shutdown': return participant.onShutdown;
  }
};

export class LifecycleManager {
  private readonly participants = new Map<string, LifecycleParticipant>();
  private readonly completed = new Set<LifecyclePhase>();
  private running = false;

  public register(participant: LifecycleParticipant): void {
    assertSafeIdentifier(participant.id, 'lifecycle participant id');
    if (this.participants.has(participant.id)) throw new NexusError('DUPLICATE_REGISTRATION', `Lifecycle participant "${participant.id}" is already registered`);
    if (this.running || this.completed.size > 0) throw new NexusError('INVALID_STATE', 'Lifecycle participants must be registered before startup begins');
    this.participants.set(participant.id, participant);
  }

  public async executeStartup(signal: AbortSignal = new AbortController().signal): Promise<void> {
    for (const phase of LIFECYCLE_PHASES) if (phase !== 'shutdown') await this.executePhase(phase, signal);
  }

  public async executeShutdown(signal: AbortSignal = new AbortController().signal): Promise<void> {
    await this.executePhase('shutdown', signal, true);
  }

  public hasCompleted(phase: LifecyclePhase): boolean { return this.completed.has(phase); }

  private async executePhase(phase: LifecyclePhase, signal: AbortSignal, reverse = false): Promise<void> {
    if (this.running) throw new NexusError('INVALID_STATE', 'A lifecycle phase is already running');
    if (this.completed.has(phase)) return;
    this.running = true;
    const context: LifecycleContext = Object.freeze({ phase, signal });
    const ordered = [...this.participants.values()].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    if (reverse) ordered.reverse();
    try {
      for (const participant of ordered) {
        if (signal.aborted) throw new NexusError('INVALID_STATE', `Lifecycle ${phase} was aborted`);
        const handler = handlerFor(participant, phase);
        if (handler !== undefined) await handler.call(participant, context);
      }
      this.completed.add(phase);
    } finally { this.running = false; }
  }
}
