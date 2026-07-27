import { EventBus, createId, type JsonObject, type Subscription } from '@nexus/core';
import { invalidArgument } from '../errors/index.js';
import { SystemClock, type Clock } from '../types/index.js';

/** Envelope wrapping every brain event with routing and audit metadata. */
export interface BrainEventEnvelope<TPayload> {
  readonly id: string;
  readonly type: string;
  readonly payload: TPayload;
  readonly source: string;
  readonly correlationId?: string;
  readonly occurredAt: string;
}

/** Events published by the brain layer's built-in components. */
export interface BrainEvents {
  readonly 'memory.stored': { readonly memoryId: string; readonly namespace: string; readonly kind: string };
  readonly 'memory.consolidated': { readonly namespace: string; readonly removed: number };
  readonly 'plan.created': { readonly planId: string; readonly goal: string; readonly stepCount: number };
  readonly 'plan.completed': { readonly planId: string; readonly status: string };
  readonly 'decision.made': { readonly decisionId: string; readonly selected: string | undefined; readonly confidence: number };
  readonly 'agent.registered': { readonly agentId: string; readonly capabilities: readonly string[] };
  readonly 'agent.invoked': { readonly agentId: string; readonly taskId: string };
  readonly 'agent.completed': { readonly agentId: string; readonly taskId: string; readonly success: boolean };
  readonly 'tool.invoked': { readonly toolName: string; readonly callId: string };
  readonly 'tool.completed': { readonly toolName: string; readonly callId: string; readonly success: boolean; readonly durationMs: number };
  readonly 'workflow.started': { readonly workflowId: string; readonly runId: string };
  readonly 'workflow.completed': { readonly workflowId: string; readonly runId: string; readonly status: string };
  readonly 'session.created': { readonly sessionId: string };
  readonly 'session.expired': { readonly sessionId: string };
  readonly 'reasoning.completed': { readonly resultId: string; readonly steps: number; readonly confidence: number };
}

/** Recorded event retained for replay and diagnostics. */
export interface RecordedEvent {
  readonly envelope: BrainEventEnvelope<unknown>;
  readonly handled: number;
}

export interface BrainEventBusOptions {
  readonly clock?: Clock;
  /** Number of events retained in the replay buffer. */
  readonly historyLimit?: number;
  readonly source?: string;
}

/**
 * Event backbone for the brain layer.
 *
 * Wraps the Phase 1 `EventBus` to add envelopes, a bounded replay buffer, and
 * dead-letter capture so a failing subscriber never blocks publication.
 */
export class BrainEventBus {
  private readonly bus = new EventBus<Record<string, BrainEventEnvelope<unknown>>>();
  private readonly history: RecordedEvent[] = [];
  private readonly deadLetters: { readonly envelope: BrainEventEnvelope<unknown>; readonly error: string }[] = [];
  private readonly clock: Clock;
  private readonly historyLimit: number;
  private readonly source: string;

  public constructor(options: BrainEventBusOptions = {}) {
    this.clock = options.clock ?? new SystemClock();
    this.historyLimit = options.historyLimit ?? 500;
    this.source = options.source ?? 'nexus.brain';
    if (!Number.isInteger(this.historyLimit) || this.historyLimit < 1) {
      throw invalidArgument('historyLimit must be a positive integer');
    }
  }

  /** Subscribes to a typed brain event. */
  public on<TName extends keyof BrainEvents & string>(
    type: TName,
    handler: (envelope: BrainEventEnvelope<BrainEvents[TName]>) => void | Promise<void>
  ): Subscription {
    return this.bus.on(type, handler as (payload: BrainEventEnvelope<unknown>) => void | Promise<void>);
  }

  /** Subscribes to an application-defined event type. */
  public onCustom<TPayload>(
    type: string,
    handler: (envelope: BrainEventEnvelope<TPayload>) => void | Promise<void>
  ): Subscription {
    return this.bus.on(type, handler as (payload: BrainEventEnvelope<unknown>) => void | Promise<void>);
  }

  /** Subscribes to every event regardless of type. */
  public onAny(handler: (type: string, envelope: BrainEventEnvelope<unknown>) => void | Promise<void>): Subscription {
    return this.bus.onAny(handler);
  }

  /**
   * Publishes an event. Subscriber failures are captured as dead letters
   * instead of propagating, keeping producers isolated from consumers.
   */
  public async publish<TName extends keyof BrainEvents & string>(
    type: TName,
    payload: BrainEvents[TName],
    options: { readonly correlationId?: string; readonly source?: string } = {}
  ): Promise<BrainEventEnvelope<BrainEvents[TName]>> {
    return this.dispatch(type, payload, options);
  }

  /** Publishes an application-defined event. */
  public async publishCustom<TPayload>(
    type: string,
    payload: TPayload,
    options: { readonly correlationId?: string; readonly source?: string } = {}
  ): Promise<BrainEventEnvelope<TPayload>> {
    if (type.trim() === '') throw invalidArgument('Event type must not be empty');
    return this.dispatch(type, payload, options);
  }

  /** Events retained in the replay buffer, oldest first. */
  public getHistory(type?: string): readonly RecordedEvent[] {
    return type === undefined ? [...this.history] : this.history.filter((entry) => entry.envelope.type === type);
  }

  /** Events whose subscribers threw during delivery. */
  public getDeadLetters(): readonly { readonly envelope: BrainEventEnvelope<unknown>; readonly error: string }[] {
    return [...this.deadLetters];
  }

  /** Re-delivers buffered events of a type to current subscribers. */
  public async replay(type: string): Promise<number> {
    const events = this.history.filter((entry) => entry.envelope.type === type);
    for (const entry of events) {
      await this.bus.emit(type, entry.envelope).catch(() => undefined);
    }
    return events.length;
  }

  public clearHistory(): void {
    this.history.length = 0;
    this.deadLetters.length = 0;
  }

  private async dispatch<TPayload>(
    type: string,
    payload: TPayload,
    options: { readonly correlationId?: string; readonly source?: string }
  ): Promise<BrainEventEnvelope<TPayload>> {
    const envelope: BrainEventEnvelope<TPayload> = {
      id: createId('evt'),
      type,
      payload,
      source: options.source ?? this.source,
      ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
      occurredAt: this.clock.timestamp()
    };

    let handled = 0;
    try {
      await this.bus.emit(type, envelope as BrainEventEnvelope<unknown>);
      handled = 1;
    } catch (error) {
      this.deadLetters.push({
        envelope: envelope as BrainEventEnvelope<unknown>,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    this.history.push({ envelope: envelope as BrainEventEnvelope<unknown>, handled });
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
    return envelope;
  }
}

/** Helper producing a JSON-safe view of an envelope for logging. */
export const describeEvent = (envelope: BrainEventEnvelope<unknown>): JsonObject => ({
  id: envelope.id,
  type: envelope.type,
  source: envelope.source,
  occurredAt: envelope.occurredAt,
  ...(envelope.correlationId === undefined ? {} : { correlationId: envelope.correlationId })
});
