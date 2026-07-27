import type { MaybePromise, Subscription } from '../types/index.js';
import { assertSafeIdentifier } from '../utils/index.js';

export interface HookContext<TPayload> { readonly name: string; readonly payload: TPayload; readonly signal: AbortSignal; }
export interface HookResult { readonly cancelled?: boolean; readonly reason?: string; }
export type HookHandler<TPayload> = (context: HookContext<TPayload>) => MaybePromise<HookResult | void>;
interface RegisteredHook<TPayload> { readonly handler: HookHandler<TPayload>; readonly priority: number; }

export class HookSystem {
  private readonly hooks = new Map<string, RegisteredHook<unknown>[]>();

  public register<TPayload>(name: string, handler: HookHandler<TPayload>, priority = 0): Subscription {
    assertSafeIdentifier(name, 'hook name');
    const entries = this.hooks.get(name) ?? [];
    const entry: RegisteredHook<TPayload> = { handler, priority };
    entries.push(entry as RegisteredHook<unknown>);
    entries.sort((a, b) => b.priority - a.priority);
    this.hooks.set(name, entries);
    let closed = false;
    return { get closed(): boolean { return closed; }, dispose: () => { if (!closed) { closed = true; const current = this.hooks.get(name); if (current !== undefined) current.splice(current.indexOf(entry as RegisteredHook<unknown>), 1); } } };
  }

  public async run<TPayload>(name: string, payload: TPayload, signal: AbortSignal = new AbortController().signal): Promise<HookResult> {
    const context: HookContext<TPayload> = Object.freeze({ name, payload, signal });
    for (const entry of [...(this.hooks.get(name) ?? [])]) {
      if (signal.aborted) return { cancelled: true, reason: 'Hook execution aborted' };
      const result = await (entry.handler as HookHandler<TPayload>)(context);
      if (result?.cancelled === true) return result;
    }
    return {};
  }
}
