import { createId, type JsonObject, type JsonValue } from '@nexus/core';
import { duplicate, invalidArgument, invalidState, notFound } from '../errors/index.js';
import type { BrainEventBus } from '../events/index.js';
import { SystemClock, type BrainContext, type Clock } from '../types/index.js';
import { assertActive } from '../utils/index.js';

/** Execution state of a workflow run. */
export type WorkflowRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'compensated';

/** Execution state of an individual step within a run. */
export type WorkflowStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'compensated';

/** Mutable state threaded through a workflow run. */
export interface WorkflowState {
  readonly input: JsonValue;
  readonly variables: JsonObject;
  readonly outputs: Readonly<Record<string, JsonValue>>;
}

/** Context supplied to a step handler. */
export interface WorkflowStepContext {
  readonly runId: string;
  readonly stepId: string;
  readonly state: WorkflowState;
  readonly brain: BrainContext;
  readonly attempt: number;
}

/** Retry policy applied to a failing step. */
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoffMs: number;
  readonly multiplier?: number;
}

/** A single node in a workflow definition. */
export interface WorkflowStep {
  readonly id: string;
  readonly name: string;
  readonly dependsOn?: readonly string[];
  /** Skips the step when this predicate returns false. */
  readonly when?: (state: WorkflowState) => boolean;
  readonly retry?: RetryPolicy;
  readonly timeoutMs?: number;
  run(context: WorkflowStepContext): Promise<JsonValue>;
  /** Undoes this step's effects when a later step fails. */
  compensate?(context: WorkflowStepContext): Promise<void>;
}

/** A reusable, versioned workflow definition. */
export interface WorkflowDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: number;
  readonly steps: readonly WorkflowStep[];
  /** Runs compensation for completed steps when the workflow fails. */
  readonly compensateOnFailure?: boolean;
}

/** Per-step execution record. */
export interface WorkflowStepExecution {
  readonly stepId: string;
  readonly status: WorkflowStepStatus;
  readonly attempts: number;
  readonly output?: JsonValue;
  readonly error?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

/** A single execution of a workflow definition. */
export interface WorkflowRun {
  readonly id: string;
  readonly workflowId: string;
  readonly status: WorkflowRunStatus;
  readonly state: WorkflowState;
  readonly executions: readonly WorkflowStepExecution[];
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly error?: string;
}

export interface WorkflowEngineOptions {
  readonly clock?: Clock;
  readonly events?: BrainEventBus;
  readonly defaultTimeoutMs?: number;
}

/**
 * Durable-style workflow orchestrator.
 *
 * Steps form a DAG and execute level by level, so independent branches run
 * concurrently. Failures trigger retries per the step's policy and, when
 * enabled, reverse-order compensation of completed steps — the saga pattern.
 */
export class WorkflowEngine {
  private readonly definitions = new Map<string, WorkflowDefinition>();
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly clock: Clock;
  private readonly events: BrainEventBus | undefined;
  private readonly defaultTimeoutMs: number;

  public constructor(options: WorkflowEngineOptions = {}) {
    this.clock = options.clock ?? new SystemClock();
    this.events = options.events;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
  }

  /** Registers a workflow definition after validating its dependency graph. */
  public register(definition: WorkflowDefinition): void {
    if (definition.steps.length === 0) throw invalidArgument('A workflow must declare at least one step');
    if (this.definitions.has(definition.id)) throw duplicate('Workflow', definition.id);

    const ids = new Set<string>();
    for (const step of definition.steps) {
      if (ids.has(step.id)) throw invalidArgument(`Duplicate workflow step id "${step.id}"`);
      ids.add(step.id);
    }
    for (const step of definition.steps) {
      for (const dependency of step.dependsOn ?? []) {
        if (!ids.has(dependency)) {
          throw invalidArgument(`Workflow step "${step.id}" depends on unknown step "${dependency}"`);
        }
      }
    }
    this.assertAcyclic(definition.steps);
    this.definitions.set(definition.id, definition);
  }

  public get(id: string): WorkflowDefinition {
    const definition = this.definitions.get(id);
    if (definition === undefined) throw notFound('Workflow', id);
    return definition;
  }

  public list(): readonly WorkflowDefinition[] {
    return [...this.definitions.values()];
  }

  public getRun(runId: string): WorkflowRun {
    const run = this.runs.get(runId);
    if (run === undefined) throw notFound('Workflow run', runId);
    return run;
  }

  public listRuns(workflowId?: string): readonly WorkflowRun[] {
    const all = [...this.runs.values()];
    return workflowId === undefined ? all : all.filter((run) => run.workflowId === workflowId);
  }

  /** Executes a workflow to completion. */
  public async execute(workflowId: string, input: JsonValue, context: BrainContext): Promise<WorkflowRun> {
    const definition = this.get(workflowId);
    const runId = createId('run');

    let state: WorkflowState = { input, variables: {}, outputs: {} };
    const executions = new Map<string, WorkflowStepExecution>(
      definition.steps.map((step) => [step.id, { stepId: step.id, status: 'pending' as WorkflowStepStatus, attempts: 0 }])
    );

    let run: WorkflowRun = {
      id: runId,
      workflowId,
      status: 'running',
      state,
      executions: [...executions.values()],
      startedAt: this.clock.timestamp()
    };
    this.runs.set(runId, run);
    await this.events?.publish('workflow.started', { workflowId, runId }, { correlationId: context.correlationId });

    const completedOrder: string[] = [];
    let failure: string | undefined;

    for (const level of this.levels(definition.steps)) {
      if (failure !== undefined) break;
      assertActive(context, `Workflow "${workflowId}"`, this.clock.now());

      const outcomes = await Promise.all(
        level.map(async (step) => {
          const current = executions.get(step.id) as WorkflowStepExecution;

          if (step.when !== undefined && !step.when(state)) {
            return { step, execution: { ...current, status: 'skipped' as WorkflowStepStatus } };
          }

          const dependenciesSatisfied = (step.dependsOn ?? []).every(
            (id) => executions.get(id)?.status === 'completed' || executions.get(id)?.status === 'skipped'
          );
          if (!dependenciesSatisfied) {
            return { step, execution: { ...current, status: 'skipped' as WorkflowStepStatus } };
          }

          return { step, execution: await this.runStep(step, runId, state, context) };
        })
      );

      for (const outcome of outcomes) {
        executions.set(outcome.step.id, outcome.execution);
        if (outcome.execution.status === 'completed') {
          completedOrder.push(outcome.step.id);
          state = {
            ...state,
            outputs: { ...state.outputs, [outcome.step.id]: outcome.execution.output ?? null }
          };
        } else if (outcome.execution.status === 'failed') {
          failure = outcome.execution.error ?? `Step "${outcome.step.id}" failed`;
        }
      }
    }

    if (failure !== undefined && definition.compensateOnFailure === true) {
      for (const stepId of [...completedOrder].reverse()) {
        const step = definition.steps.find((candidate) => candidate.id === stepId);
        if (step?.compensate === undefined) continue;
        try {
          await step.compensate({ runId, stepId, state, brain: context, attempt: 1 });
          const execution = executions.get(stepId);
          if (execution !== undefined) executions.set(stepId, { ...execution, status: 'compensated' });
        } catch {
          // Compensation is best-effort; the original failure remains authoritative.
        }
      }
    }

    const status: WorkflowRunStatus =
      failure === undefined ? 'completed' : definition.compensateOnFailure === true ? 'compensated' : 'failed';

    run = {
      ...run,
      status,
      state,
      executions: [...executions.values()],
      completedAt: this.clock.timestamp(),
      ...(failure === undefined ? {} : { error: failure })
    };
    this.runs.set(runId, run);
    await this.events?.publish('workflow.completed', { workflowId, runId, status }, { correlationId: context.correlationId });
    return run;
  }

  /** Marks a pending or running workflow run as cancelled. */
  public cancel(runId: string): WorkflowRun {
    const run = this.getRun(runId);
    if (run.status === 'completed' || run.status === 'failed') {
      throw invalidState(`Workflow run "${runId}" already finished`, { status: run.status });
    }
    const cancelled: WorkflowRun = { ...run, status: 'cancelled', completedAt: this.clock.timestamp() };
    this.runs.set(runId, cancelled);
    return cancelled;
  }

  private async runStep(
    step: WorkflowStep,
    runId: string,
    state: WorkflowState,
    context: BrainContext
  ): Promise<WorkflowStepExecution> {
    const policy = step.retry ?? { maxAttempts: 1, backoffMs: 0 };
    if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
      throw invalidArgument(`Step "${step.id}" maxAttempts must be a positive integer`);
    }
    const startedAt = this.clock.timestamp();
    let lastError = 'Step failed';

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      try {
        const output = await this.withTimeout(
          step.run({ runId, stepId: step.id, state, brain: context, attempt }),
          step.timeoutMs ?? this.defaultTimeoutMs,
          step.id
        );
        return {
          stepId: step.id,
          status: 'completed',
          attempts: attempt,
          output,
          startedAt,
          completedAt: this.clock.timestamp()
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < policy.maxAttempts) {
          const multiplier = policy.multiplier ?? 2;
          await this.delay(policy.backoffMs * multiplier ** (attempt - 1));
        }
      }
    }

    return {
      stepId: step.id,
      status: 'failed',
      attempts: policy.maxAttempts,
      error: lastError,
      startedAt,
      completedAt: this.clock.timestamp()
    };
  }

  private levels(steps: readonly WorkflowStep[]): readonly (readonly WorkflowStep[])[] {
    const remaining = new Map(steps.map((step) => [step.id, step]));
    const resolved = new Set<string>();
    const levels: WorkflowStep[][] = [];

    while (remaining.size > 0) {
      const level = [...remaining.values()].filter((step) => (step.dependsOn ?? []).every((id) => resolved.has(id)));
      if (level.length === 0) throw invalidArgument('Workflow contains an unsatisfiable dependency');
      for (const step of level) {
        remaining.delete(step.id);
        resolved.add(step.id);
      }
      levels.push(level);
    }
    return levels;
  }

  private assertAcyclic(steps: readonly WorkflowStep[]): void {
    const byId = new Map(steps.map((step) => [step.id, step]));
    const state = new Map<string, 'visiting' | 'done'>();

    const visit = (id: string, trail: readonly string[]): void => {
      const status = state.get(id);
      if (status === 'done') return;
      if (status === 'visiting') {
        throw invalidArgument(`Workflow contains a dependency cycle: ${[...trail, id].join(' -> ')}`);
      }
      state.set(id, 'visiting');
      for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency, [...trail, id]);
      state.set(id, 'done');
    };

    for (const step of steps) visit(step.id, []);
  }

  private async withTimeout<T>(operation: Promise<T>, timeoutMs: number, stepId: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Step "${stepId}" timed out after ${timeoutMs}ms`)), timeoutMs);
        })
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async delay(milliseconds: number): Promise<void> {
    if (milliseconds <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }
}
