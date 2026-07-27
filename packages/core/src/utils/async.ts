import { NexusError } from '../errors/index.js';
import type { MaybePromise } from '../types/index.js';

export class Deferred<T> {
  public readonly promise: Promise<T>;
  private settled = false;
  private readonly resolvePromise: (value: T | PromiseLike<T>) => void;
  private readonly rejectPromise: (reason?: unknown) => void;

  public constructor() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    this.promise = new Promise<T>((innerResolve, innerReject) => { resolve = innerResolve; reject = innerReject; });
    this.resolvePromise = resolve;
    this.rejectPromise = reject;
  }

  public resolve(value: T): void { if (!this.settled) { this.settled = true; this.resolvePromise(value); } }
  public reject(reason: unknown): void { if (!this.settled) { this.settled = true; this.rejectPromise(reason); } }
}

export const withTimeout = async <T>(operation: MaybePromise<T>, timeoutMs: number, label = 'Operation'): Promise<T> => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new NexusError('INVALID_ARGUMENT', 'timeoutMs must be greater than zero');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NexusError('TIMEOUT', `${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try { return await Promise.race([Promise.resolve(operation), timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
};

export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  public async runExclusive<T>(operation: () => MaybePromise<T>): Promise<T> {
    const previous = this.tail;
    const release = new Deferred<void>();
    this.tail = previous.then(() => release.promise, () => release.promise);
    await previous;
    try { return await operation(); } finally { release.resolve(); }
  }
}
