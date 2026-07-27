import type { MaybePromise, Subscription } from '../types/index.js';

export type EventMap = object;
export type EventHandler<TPayload> = (payload: TPayload) => MaybePromise<void>;
export type WildcardEventHandler<TEvents extends EventMap> = <TName extends keyof TEvents & string>(event: TName, payload: TEvents[TName]) => MaybePromise<void>;

interface Listener<TPayload> { readonly handler: EventHandler<TPayload>; readonly once: boolean; }

/** A typed, ordered event bus. A failed listener rejects publishing and leaves other listeners observable. */
export class EventBus<TEvents extends EventMap> {
  private readonly listeners = new Map<keyof TEvents & string, Set<Listener<unknown>>>();
  private readonly wildcardListeners = new Set<WildcardEventHandler<TEvents>>();

  public on<TName extends keyof TEvents & string>(event: TName, handler: EventHandler<TEvents[TName]>): Subscription {
    const listeners = this.listeners.get(event) ?? new Set<Listener<unknown>>();
    const listener: Listener<TEvents[TName]> = { handler, once: false };
    listeners.add(listener as Listener<unknown>);
    this.listeners.set(event, listeners);
    return this.subscription(() => listeners.delete(listener as Listener<unknown>));
  }

  public once<TName extends keyof TEvents & string>(event: TName, handler: EventHandler<TEvents[TName]>): Subscription {
    const listeners = this.listeners.get(event) ?? new Set<Listener<unknown>>();
    const listener: Listener<TEvents[TName]> = { handler, once: true };
    listeners.add(listener as Listener<unknown>);
    this.listeners.set(event, listeners);
    return this.subscription(() => listeners.delete(listener as Listener<unknown>));
  }

  public onAny(handler: WildcardEventHandler<TEvents>): Subscription {
    this.wildcardListeners.add(handler);
    return this.subscription(() => this.wildcardListeners.delete(handler));
  }

  public async emit<TName extends keyof TEvents & string>(event: TName, payload: TEvents[TName]): Promise<void> {
    const listeners = [...(this.listeners.get(event) ?? [])];
    const failures: unknown[] = [];
    for (const listener of listeners) {
      try { await (listener.handler as EventHandler<TEvents[TName]>)(payload); }
      catch (error) { failures.push(error); }
      finally { if (listener.once) this.listeners.get(event)?.delete(listener); }
    }
    for (const listener of [...this.wildcardListeners]) {
      try { await listener(event, payload); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, `One or more listeners failed for event ${event}`);
  }

  public clear(event?: keyof TEvents & string): void { if (event === undefined) { this.listeners.clear(); this.wildcardListeners.clear(); } else this.listeners.delete(event); }

  private subscription(disposeAction: () => void): Subscription {
    let closed = false;
    return { get closed(): boolean { return closed; }, dispose: () => { if (!closed) { closed = true; disposeAction(); } } };
  }
}
