import { createId, type JsonValue } from '@nexus/core';

export interface RuntimeStreamEvent { readonly id: string; readonly type: string; readonly data: JsonValue; readonly occurredAt: string; }
export interface StreamSubscription { readonly id: string; close(): void; }
export interface WebSocketPeer { readonly readyState: number; send(data: string): void; close?(code?: number, reason?: string): void; }

/** Bounded in-process fan-out hub suitable for SSE, WebSocket, and test adapters. */
export class RuntimeStreamHub {
  private readonly subscribers = new Map<string, (event: RuntimeStreamEvent) => void>();
  public constructor(private readonly historyLimit = 250, private readonly now: () => string = () => new Date().toISOString()) {}
  private readonly history: RuntimeStreamEvent[] = [];

  public publish(type: string, data: JsonValue): RuntimeStreamEvent {
    const event = Object.freeze({ id: createId('stream'), type, data, occurredAt: this.now() });
    this.history.push(event); if (this.history.length > this.historyLimit) this.history.shift();
    for (const handler of this.subscribers.values()) { try { handler(event); } catch { /* isolate transport clients */ } }
    return event;
  }
  public subscribe(handler: (event: RuntimeStreamEvent) => void, afterId?: string): StreamSubscription {
    if (afterId !== undefined) { const at = this.history.findIndex((event) => event.id === afterId); for (const event of this.history.slice(at + 1)) handler(event); }
    const id = createId('sub'); this.subscribers.set(id, handler);
    return { id, close: () => { this.subscribers.delete(id); } };
  }
  public events(): readonly RuntimeStreamEvent[] { return [...this.history]; }
  public get subscriberCount(): number { return this.subscribers.size; }
}

/** Transport-neutral WebSocket adapter; callers provide their platform's socket object. */
export class WebSocketRuntimeBridge {
  public attach(peer: WebSocketPeer, hub: RuntimeStreamHub, afterId?: string): StreamSubscription {
    const subscription = hub.subscribe((event) => { if (peer.readyState === 1) peer.send(JSON.stringify(event)); }, afterId);
    return subscription;
  }
}
