import { createId, type JsonObject } from '@nexus/core';
import { invalidArgument, notFound } from '../errors/index.js';
import { SystemClock, type BrainContext, type Clock } from '../types/index.js';
import { assertActive } from '../utils/index.js';

/** Execution state of a single plan step. */
export type PlanStepStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'skipped';

/** Overall state of a plan. */
export type PlanStatus = 'draft' | 'ready' | 'executing' | 'completed' | 'failed' | 'cancelled';

/** One unit of work inside a plan. */
export interface PlanStep {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly action: string;
  readonly input: JsonObject;
  readonly dependsOn: readonly string[];
  readonly status: PlanStepStatus;
  readonly estimatedCost: number;
  readonly output?: JsonObject;
  readonly error?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

/** A directed acyclic graph of steps that satisfies a goal. */
export interface Plan {
  readonly id: string;
  readonly goal: string;
  readonly status: PlanStatus;
  readonly steps: readonly PlanStep[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata: JsonObject;
}

/** Declarative description of a step before the plan is compiled. */
export interface PlanStepDraft {
  readonly id?: string;
  readonly name: string;
  readonly description?: string;
  readonly action: string;
  readonly input?: JsonObject;
  readonly dependsOn?: readonly string[];
  readonly estimatedCost?: number;
}

/** Produces candidate steps for a goal. */
export interface PlanStrategy {
  readonly id: string;
  readonly description: string;
  /** Returns `undefined` when the strategy cannot handle the goal. */
  plan(goal: string, context: BrainContext): Promise<readonly PlanStepDraft[] | undefined>;
}

export interface PlanningOptions {
  readonly clock?: Clock;
  readonly maxSteps?: number;
}

/**
 * Builds and sequences executable plans.
 *
 * Plans are DAGs: the engine validates dependencies, rejects cycles, and
 * exposes topological levels so independent steps can run in parallel.
 */
export class PlanningEngine {
  private readonly strategies = new Map<string, PlanStrategy>();
  private readonly plans = new Map<string, Plan>();
  private readonly clock: Clock;
  private readonly maxSteps: number;

  public constructor(options: PlanningOptions = {}) {
    this.clock = options.clock ?? new SystemClock();
    this.maxSteps = options.maxSteps ?? 256;
    if (!Number.isInteger(this.maxSteps) || this.maxSteps < 1) {
      throw invalidArgument('maxSteps must be a positive integer');
    }
  }

  /** Registers a planning strategy. */
  public registerStrategy(strategy: PlanStrategy): void {
    if (strategy.id.trim() === '') throw invalidArgument('Strategy id must not be empty');
    this.strategies.set(strategy.id, strategy);
  }

  public listStrategies(): readonly PlanStrategy[] {
    return [...this.strategies.values()];
  }

  /** Compiles explicit step drafts into a validated plan. */
  public compile(goal: string, drafts: readonly PlanStepDraft[], metadata: JsonObject = {}): Plan {
    if (goal.trim() === '') throw invalidArgument('Plan goal must not be empty');
    if (drafts.length === 0) throw invalidArgument('A plan must contain at least one step');
    if (drafts.length > this.maxSteps) throw invalidArgument(`A plan may not exceed ${this.maxSteps} steps`);

    const steps: PlanStep[] = drafts.map((draft, index) => {
      const id = draft.id ?? `step-${index + 1}`;
      const cost = draft.estimatedCost ?? 1;
      if (!Number.isFinite(cost) || cost < 0) throw invalidArgument(`Step "${id}" cost must be a non-negative number`);
      return {
        id,
        name: draft.name,
        description: draft.description ?? draft.name,
        action: draft.action,
        input: draft.input ?? {},
        dependsOn: Object.freeze([...new Set(draft.dependsOn ?? [])]),
        status: 'pending' as PlanStepStatus,
        estimatedCost: cost
      };
    });

    const ids = new Set<string>();
    for (const step of steps) {
      if (ids.has(step.id)) throw invalidArgument(`Duplicate plan step id "${step.id}"`);
      ids.add(step.id);
    }
    for (const step of steps) {
      for (const dependency of step.dependsOn) {
        if (!ids.has(dependency)) {
          throw invalidArgument(`Step "${step.id}" depends on unknown step "${dependency}"`);
        }
      }
    }
    this.assertAcyclic(steps);

    const now = this.clock.timestamp();
    const plan: Plan = {
      id: createId('plan'),
      goal,
      status: 'ready',
      steps: this.markReadySteps(steps),
      createdAt: now,
      updatedAt: now,
      metadata
    };
    this.plans.set(plan.id, plan);
    return plan;
  }

  /** Creates a plan by consulting registered strategies in registration order. */
  public async createPlan(goal: string, context: BrainContext, metadata: JsonObject = {}): Promise<Plan> {
    assertActive(context, 'Planning', this.clock.now());
    for (const strategy of this.strategies.values()) {
      const drafts = await strategy.plan(goal, context);
      if (drafts !== undefined && drafts.length > 0) {
        return this.compile(goal, drafts, { ...metadata, strategy: strategy.id });
      }
    }
    throw invalidArgument(`No planning strategy produced a plan for goal "${goal}"`);
  }

  public getPlan(id: string): Plan {
    const plan = this.plans.get(id);
    if (plan === undefined) throw notFound('Plan', id);
    return plan;
  }

  public listPlans(): readonly Plan[] {
    return [...this.plans.values()];
  }

  /**
   * Returns steps grouped into dependency levels. Every step in a level can be
   * executed concurrently once all previous levels have completed.
   */
  public levels(planId: string): readonly (readonly PlanStep[])[] {
    const plan = this.getPlan(planId);
    const remaining = new Map(plan.steps.map((step) => [step.id, step]));
    const resolved = new Set<string>();
    const levels: PlanStep[][] = [];

    while (remaining.size > 0) {
      const level = [...remaining.values()].filter((step) => step.dependsOn.every((id) => resolved.has(id)));
      if (level.length === 0) throw invalidArgument(`Plan "${planId}" contains an unsatisfiable dependency`);
      for (const step of level) {
        remaining.delete(step.id);
        resolved.add(step.id);
      }
      levels.push(level);
    }
    return levels;
  }

  /** Steps whose dependencies are all complete and which have not yet run. */
  public readySteps(planId: string): readonly PlanStep[] {
    const plan = this.getPlan(planId);
    const completed = new Set(plan.steps.filter((step) => step.status === 'completed').map((step) => step.id));
    return plan.steps.filter((step) => step.status !== 'completed' && step.status !== 'running' && step.status !== 'failed' && step.status !== 'skipped' && step.dependsOn.every((id) => completed.has(id)));
  }

  /** Applies a status transition to a step and recomputes plan status. */
  public updateStep(
    planId: string,
    stepId: string,
    changes: { readonly status: PlanStepStatus; readonly output?: JsonObject; readonly error?: string }
  ): Plan {
    const plan = this.getPlan(planId);
    const index = plan.steps.findIndex((step) => step.id === stepId);
    if (index < 0) throw notFound('Plan step', stepId);
    const current = plan.steps[index] as PlanStep;
    const now = this.clock.timestamp();

    const updatedStep: PlanStep = {
      ...current,
      status: changes.status,
      ...(changes.output === undefined ? {} : { output: changes.output }),
      ...(changes.error === undefined ? {} : { error: changes.error }),
      ...(changes.status === 'running' ? { startedAt: now } : {}),
      ...(changes.status === 'completed' || changes.status === 'failed' ? { completedAt: now } : {})
    };

    const steps = [...plan.steps];
    steps[index] = updatedStep;

    const updated: Plan = {
      ...plan,
      steps: this.markReadySteps(steps),
      status: this.derivePlanStatus(steps, plan.status),
      updatedAt: now
    };
    this.plans.set(planId, updated);
    return updated;
  }

  /** Marks a plan cancelled and skips every step that has not finished. */
  public cancel(planId: string): Plan {
    const plan = this.getPlan(planId);
    const steps = plan.steps.map((step) =>
      step.status === 'completed' || step.status === 'failed' ? step : { ...step, status: 'skipped' as PlanStepStatus }
    );
    const cancelled: Plan = { ...plan, steps, status: 'cancelled', updatedAt: this.clock.timestamp() };
    this.plans.set(planId, cancelled);
    return cancelled;
  }

  /** Total estimated cost of every step in the plan. */
  public estimateCost(planId: string): number {
    return this.getPlan(planId).steps.reduce((total, step) => total + step.estimatedCost, 0);
  }

  /** Longest dependency chain by cost, i.e. the plan's minimum execution cost. */
  public criticalPath(planId: string): readonly PlanStep[] {
    const plan = this.getPlan(planId);
    const byId = new Map(plan.steps.map((step) => [step.id, step]));
    const memo = new Map<string, { readonly cost: number; readonly path: readonly PlanStep[] }>();

    const walk = (stepId: string): { readonly cost: number; readonly path: readonly PlanStep[] } => {
      const cached = memo.get(stepId);
      if (cached !== undefined) return cached;
      const step = byId.get(stepId) as PlanStep;
      let best: { readonly cost: number; readonly path: readonly PlanStep[] } = { cost: 0, path: [] };
      for (const dependency of step.dependsOn) {
        const candidate = walk(dependency);
        if (candidate.cost > best.cost) best = candidate;
      }
      const result = { cost: best.cost + step.estimatedCost, path: [...best.path, step] };
      memo.set(stepId, result);
      return result;
    };

    let longest: { readonly cost: number; readonly path: readonly PlanStep[] } = { cost: 0, path: [] };
    for (const step of plan.steps) {
      const candidate = walk(step.id);
      if (candidate.cost > longest.cost) longest = candidate;
    }
    return longest.path;
  }

  private markReadySteps(steps: readonly PlanStep[]): readonly PlanStep[] {
    const completed = new Set(steps.filter((step) => step.status === 'completed').map((step) => step.id));
    return steps.map((step) =>
      step.status === 'pending' && step.dependsOn.every((id) => completed.has(id)) ? { ...step, status: 'ready' as PlanStepStatus } : step
    );
  }

  private derivePlanStatus(steps: readonly PlanStep[], current: PlanStatus): PlanStatus {
    if (current === 'cancelled') return current;
    if (steps.some((step) => step.status === 'failed')) return 'failed';
    if (steps.every((step) => step.status === 'completed' || step.status === 'skipped')) return 'completed';
    if (steps.some((step) => step.status === 'running' || step.status === 'completed')) return 'executing';
    return 'ready';
  }

  private assertAcyclic(steps: readonly PlanStep[]): void {
    const byId = new Map(steps.map((step) => [step.id, step]));
    const state = new Map<string, 'visiting' | 'done'>();

    const visit = (id: string, trail: readonly string[]): void => {
      const status = state.get(id);
      if (status === 'done') return;
      if (status === 'visiting') {
        throw invalidArgument(`Plan contains a dependency cycle: ${[...trail, id].join(' -> ')}`);
      }
      state.set(id, 'visiting');
      for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency, [...trail, id]);
      state.set(id, 'done');
    };

    for (const step of steps) visit(step.id, []);
  }
}
