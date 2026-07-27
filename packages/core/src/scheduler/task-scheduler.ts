import { DEFAULT_SCHEDULER_CONCURRENCY } from '../constants/index.js';
import { NexusError } from '../errors/index.js';
import type { MaybePromise } from '../types/index.js';
import { assertSafeIdentifier } from '../utils/index.js';

export interface ScheduledTaskContext { readonly taskId: string; readonly signal: AbortSignal; readonly scheduledAt: Date; }
export interface ScheduledTask { readonly id: string; readonly intervalMs: number; readonly run: (context: ScheduledTaskContext) => MaybePromise<void>; }
export interface TaskFailure { readonly taskId: string; readonly error: unknown; readonly occurredAt: string; }
export type TaskFailureHandler = (failure: TaskFailure) => void | Promise<void>;

interface TaskRecord { readonly task: ScheduledTask; timer?: ReturnType<typeof setTimeout>; running: boolean; }
interface QueuedRun { readonly operation: () => Promise<void>; readonly resolve: () => void; }

/** Cooperative interval scheduler with bounded parallelism, no overlapping task runs, and graceful cancellation. */
export class TaskScheduler {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly pending: QueuedRun[] = [];
  private readonly executions = new Set<Promise<void>>();
  private abortController = new AbortController();
  private active = 0;
  private started = false;

  public constructor(private readonly concurrency = DEFAULT_SCHEDULER_CONCURRENCY, private readonly onFailure?: TaskFailureHandler) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new NexusError('INVALID_ARGUMENT', 'Scheduler concurrency must be a positive integer');
  }

  public register(task: ScheduledTask): void {
    assertSafeIdentifier(task.id, 'task id');
    if (!Number.isFinite(task.intervalMs) || task.intervalMs < 10) throw new NexusError('INVALID_ARGUMENT', 'Task interval must be at least 10ms');
    if (this.tasks.has(task.id)) throw new NexusError('DUPLICATE_REGISTRATION', `Task "${task.id}" is already registered`);
    const record: TaskRecord = { task, running: false };
    this.tasks.set(task.id, record);
    if (this.started) this.plan(record, 0);
  }

  public async start(): Promise<void> {
    if (this.started) return;
    if (this.abortController.signal.aborted) this.abortController = new AbortController();
    this.started = true;
    for (const record of this.tasks.values()) this.plan(record, 0);
  }

  public async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.abortController.abort();
    for (const record of this.tasks.values()) {
      if (record.timer !== undefined) clearTimeout(record.timer);
      delete record.timer;
    }
    for (const queued of this.pending.splice(0)) queued.resolve();
    await Promise.allSettled([...this.executions]);
  }

  public async runNow(id: string): Promise<void> {
    const record = this.tasks.get(id);
    if (record === undefined) throw new NexusError('NOT_FOUND', `Task "${id}" is not registered`);
    if (!this.started) throw new NexusError('INVALID_STATE', 'Scheduler must be started before tasks can run');
    await this.enqueue(record);
  }

  public list(): readonly { readonly id: string; readonly intervalMs: number; readonly running: boolean }[] {
    return [...this.tasks.values()].map((record) => Object.freeze({ id: record.task.id, intervalMs: record.task.intervalMs, running: record.running }));
  }

  private plan(record: TaskRecord, delay: number): void {
    if (!this.started) return;
    record.timer = setTimeout(() => {
      void this.enqueue(record).finally(() => this.plan(record, record.task.intervalMs));
    }, delay);
  }

  private async enqueue(record: TaskRecord): Promise<void> {
    if (record.running || this.abortController.signal.aborted) return;
    const operation = async (): Promise<void> => {
      record.running = true;
      try { await record.task.run({ taskId: record.task.id, signal: this.abortController.signal, scheduledAt: new Date() }); }
      catch (error) { await this.reportFailure(record.task.id, error); }
      finally { record.running = false; }
    };
    await new Promise<void>((resolve) => {
      const run: QueuedRun = { operation, resolve };
      if (this.active < this.concurrency) this.execute(run);
      else this.pending.push(run);
    });
  }

  private execute(run: QueuedRun): void {
    this.active += 1;
    const execution = run.operation().finally(() => {
      this.active -= 1;
      run.resolve();
      this.executions.delete(execution);
      this.drain();
    });
    this.executions.add(execution);
  }

  private drain(): void {
    while (this.active < this.concurrency) {
      const run = this.pending.shift();
      if (run === undefined) return;
      if (this.abortController.signal.aborted) { run.resolve(); continue; }
      this.execute(run);
    }
  }

  private async reportFailure(taskId: string, error: unknown): Promise<void> {
    if (this.onFailure === undefined) return;
    try { await this.onFailure({ taskId, error, occurredAt: new Date().toISOString() }); } catch { return; }
  }
}
