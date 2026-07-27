import { createId, type JsonObject } from '@nexus/core';
import { invalidArgument, notFound } from '../errors/index.js';
import { SystemClock, type Clock } from '../types/index.js';

/** A value that may be returned directly or as a promise. */
export type MaybePromiseLike<T> = T | Promise<T>;

/** Lifecycle state of a scheduled job. */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'dead';

/** A unit of deferred work. */
export interface Job<TResult = unknown> {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly runAt: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly backoffMs: number;
  readonly status: JobStatus;
  readonly result?: TResult;
  readonly error?: string;
  readonly metadata: JsonObject;
  readonly enqueuedAt: string;
}

/** The callable body of a job. */
export type JobHandler<TResult> = (job: Job<TResult>) => MaybePromiseLike<TResult>;

export interface EnqueueOptions {
  readonly name: string;
  readonly priority?: number;
  readonly delayMs?: number;
  readonly maxAttempts?: number;
  readonly backoffMs?: number;
  readonly metadata?: JsonObject;
  readonly id?: string;
}

export interface BrainSchedulerOptions {
  readonly clock?: Clock;
  readonly concurrency?: number;
  /** Invoked when a job exhausts its retries. */
  readonly onDeadLetter?: (job: Job<unknown>) => void | Promise<void>;
}

interface QueuedJob {
  job: Job<unknown>;
  readonly handler: JobHandler<unknown>;
}

/**
 * Priority job queue with delays, retries, and bounded concurrency.
 *
 * This complements the Phase 1 interval `TaskScheduler`: that one repeats fixed
 * tasks on a timer, while this one runs one-shot prioritized work with
 * exponential backoff and a dead-letter path.
 *
 * `drain()` is deterministic and is what tests and workers should call; the
 * queue does not spin a background timer of its own.
 */
export class BrainTaskScheduler {
  private readonly queue: QueuedJob[] = [];
  private readonly finished = new Map<string, Job<unknown>>();
  private readonly clock: Clock;
  private readonly concurrency: number;
  private readonly onDeadLetter: ((job: Job<unknown>) => void | Promise<void>) | undefined;

  public constructor(options: BrainSchedulerOptions = {}) {
    this.clock = options.clock ?? new SystemClock();
    this.concurrency = options.concurrency ?? 4;
    this.onDeadLetter = options.onDeadLetter;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1) {
      throw invalidArgument('Scheduler concurrency must be a positive integer');
    }
  }

  /** Adds a job to the queue. */
  public enqueue<TResult>(options: EnqueueOptions, handler: JobHandler<TResult>): Job<TResult> {
    if (options.name.trim() === '') throw invalidArgument('Job name must not be empty');
    const maxAttempts = options.maxAttempts ?? 1;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw invalidArgument('maxAttempts must be a positive integer');
    }
    const delayMs = options.delayMs ?? 0;
    if (!Number.isFinite(delayMs) || delayMs < 0) throw invalidArgument('delayMs must be non-negative');

    const job: Job<TResult> = {
      id: options.id ?? createId('job'),
      name: options.name,
      priority: options.priority ?? 0,
      runAt: this.clock.now() + delayMs,
      attempts: 0,
      maxAttempts,
      backoffMs: options.backoffMs ?? 100,
      status: 'queued',
      metadata: options.metadata ?? {},
      enqueuedAt: this.clock.timestamp()
    };

    this.queue.push({ job: job as Job<unknown>, handler: handler as JobHandler<unknown> });
    return job;
  }

  /** Jobs eligible to run at the current clock time, highest priority first. */
  public dueJobs(): readonly Job<unknown>[] {
    const now = this.clock.now();
    return this.queue
      .filter((entry) => entry.job.status === 'queued' && entry.job.runAt <= now)
      .map((entry) => entry.job)
      .sort((left, right) => (right.priority === left.priority ? left.runAt - right.runAt : right.priority - left.priority));
  }

  /**
   * Runs every due job, honouring concurrency and retry policy.
   *
   * Returns the jobs that reached a terminal state during this pass.
   */
  public async drain(): Promise<readonly Job<unknown>[]> {
    const completed: Job<unknown>[] = [];

    for (;;) {
      const due = this.dueJobs();
      if (due.length === 0) break;

      const batch = due.slice(0, this.concurrency);
      const settled = await Promise.all(batch.map((job) => this.runJob(job.id)));
      const terminal = settled.filter((job): job is Job<unknown> => job !== undefined);
      completed.push(...terminal);
      if (terminal.length === 0 && settled.length === 0) break;
    }

    return completed;
  }

  /** Executes one job by id, applying its retry policy. */
  public async runJob(id: string): Promise<Job<unknown> | undefined> {
    const entry = this.queue.find((candidate) => candidate.job.id === id);
    if (entry === undefined) return undefined;
    if (entry.job.status !== 'queued') return undefined;

    entry.job = { ...entry.job, status: 'running', attempts: entry.job.attempts + 1 };

    try {
      const result = await entry.handler(entry.job);
      entry.job = { ...entry.job, status: 'succeeded', result };
      this.settle(entry);
      return entry.job;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (entry.job.attempts < entry.job.maxAttempts) {
        // Exponential backoff keeps a failing dependency from being hammered.
        const delay = entry.job.backoffMs * 2 ** (entry.job.attempts - 1);
        entry.job = { ...entry.job, status: 'queued', error: message, runAt: this.clock.now() + delay };
        return undefined;
      }
      entry.job = { ...entry.job, status: entry.job.maxAttempts > 1 ? 'dead' : 'failed', error: message };
      this.settle(entry);
      if (this.onDeadLetter !== undefined) {
        await Promise.resolve(this.onDeadLetter(entry.job)).catch(() => undefined);
      }
      return entry.job;
    }
  }

  /** Removes a queued job from the queue. */
  public cancel(id: string): Job<unknown> {
    const index = this.queue.findIndex((entry) => entry.job.id === id);
    if (index < 0) throw notFound('Job', id);
    const entry = this.queue[index] as QueuedJob;
    const cancelled: Job<unknown> = { ...entry.job, status: 'cancelled' };
    this.queue.splice(index, 1);
    this.finished.set(id, cancelled);
    return cancelled;
  }

  /** Looks up a job whether it is queued or finished. */
  public get(id: string): Job<unknown> {
    const queued = this.queue.find((entry) => entry.job.id === id)?.job;
    const job = queued ?? this.finished.get(id);
    if (job === undefined) throw notFound('Job', id);
    return job;
  }

  public pending(): readonly Job<unknown>[] {
    return this.queue.map((entry) => entry.job);
  }

  public completed(): readonly Job<unknown>[] {
    return [...this.finished.values()];
  }

  /** Jobs that exhausted every retry. */
  public deadLetters(): readonly Job<unknown>[] {
    return [...this.finished.values()].filter((job) => job.status === 'dead' || job.status === 'failed');
  }

  public get size(): number {
    return this.queue.length;
  }

  public clearCompleted(): void {
    this.finished.clear();
  }

  private settle(entry: QueuedJob): void {
    const index = this.queue.indexOf(entry);
    if (index >= 0) this.queue.splice(index, 1);
    this.finished.set(entry.job.id, entry.job);
  }
}
