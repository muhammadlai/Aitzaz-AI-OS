import { createId, type JsonObject } from '@nexus/core';
import { invalidArgument } from '../errors/index.js';
import { SystemClock, type BrainContext, type Clock, type Confidence } from '../types/index.js';
import { assertActive } from '../utils/index.js';

/** A candidate the decision engine may select. */
export interface DecisionOption {
  readonly id: string;
  readonly label: string;
  readonly attributes: Readonly<Record<string, number>>;
  readonly metadata: JsonObject;
}

/** A weighted criterion used to score options. */
export interface DecisionCriterion {
  readonly id: string;
  readonly attribute: string;
  readonly weight: number;
  /** `maximize` prefers larger values, `minimize` prefers smaller ones. */
  readonly direction: 'maximize' | 'minimize';
  /** Options scoring below this normalized threshold are eliminated. */
  readonly threshold?: number;
}

/** A hard rule that can veto an option outright. */
export interface DecisionConstraint {
  readonly id: string;
  readonly description: string;
  readonly permits: (option: DecisionOption) => boolean;
}

/** Per-option scoring detail. */
export interface OptionScore {
  readonly option: DecisionOption;
  readonly score: number;
  readonly normalized: Readonly<Record<string, number>>;
  readonly eliminated: boolean;
  readonly eliminationReason?: string;
}

/** Outcome of a decision run. */
export interface Decision {
  readonly id: string;
  readonly selected: DecisionOption | undefined;
  readonly confidence: Confidence;
  readonly scores: readonly OptionScore[];
  readonly rationale: string;
  readonly decidedAt: string;
}

export interface DecisionRequest {
  readonly context: BrainContext;
  readonly options: readonly DecisionOption[];
  readonly criteria: readonly DecisionCriterion[];
  readonly constraints?: readonly DecisionConstraint[];
  /** Minimum score gap to the runner-up required for a confident decision. */
  readonly decisiveMargin?: number;
}

export interface DecisionEngineOptions {
  readonly clock?: Clock;
}

/**
 * Multi-criteria decision engine.
 *
 * Attributes are min-max normalized across the candidate set so criteria with
 * different units contribute fairly to a weighted score. Hard constraints veto
 * options before scoring, and confidence reflects the margin over the
 * runner-up rather than the raw score.
 */
export class DecisionEngine {
  private readonly clock: Clock;
  private readonly history: Decision[] = [];

  public constructor(options: DecisionEngineOptions = {}) {
    this.clock = options.clock ?? new SystemClock();
  }

  /** Evaluates every option and selects the highest scoring survivor. */
  public async decide(request: DecisionRequest): Promise<Decision> {
    assertActive(request.context, 'Decision', this.clock.now());
    if (request.options.length === 0) throw invalidArgument('At least one option is required');
    if (request.criteria.length === 0) throw invalidArgument('At least one criterion is required');

    const totalWeight = request.criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
    if (totalWeight <= 0) throw invalidArgument('Criterion weights must sum to a positive number');
    for (const criterion of request.criteria) {
      if (!Number.isFinite(criterion.weight) || criterion.weight < 0) {
        throw invalidArgument(`Criterion "${criterion.id}" weight must be a non-negative finite number`);
      }
    }

    const ranges = new Map<string, { readonly min: number; readonly max: number }>();
    for (const criterion of request.criteria) {
      const values = request.options.map((option) => option.attributes[criterion.attribute] ?? 0);
      ranges.set(criterion.attribute, { min: Math.min(...values), max: Math.max(...values) });
    }

    const scores: OptionScore[] = request.options.map((option) => {
      const violated = (request.constraints ?? []).find((constraint) => !constraint.permits(option));
      if (violated !== undefined) {
        return {
          option,
          score: 0,
          normalized: {},
          eliminated: true,
          eliminationReason: `Violates constraint "${violated.id}": ${violated.description}`
        };
      }

      const normalized: Record<string, number> = {};
      let weighted = 0;
      let thresholdFailure: string | undefined;

      for (const criterion of request.criteria) {
        const range = ranges.get(criterion.attribute) as { readonly min: number; readonly max: number };
        const raw = option.attributes[criterion.attribute] ?? 0;
        // A flat range means the criterion cannot discriminate; treat all as ideal.
        const span = range.max - range.min;
        const scaled = span === 0 ? 1 : (raw - range.min) / span;
        const oriented = criterion.direction === 'maximize' ? scaled : 1 - scaled;
        normalized[criterion.id] = oriented;
        if (criterion.threshold !== undefined && oriented < criterion.threshold) {
          thresholdFailure = `Fails threshold on criterion "${criterion.id}"`;
        }
        weighted += oriented * (criterion.weight / totalWeight);
      }

      return thresholdFailure === undefined
        ? { option, score: weighted, normalized, eliminated: false }
        : { option, score: weighted, normalized, eliminated: true, eliminationReason: thresholdFailure };
    });

    const viable = scores
      .filter((entry) => !entry.eliminated)
      .sort((left, right) => (right.score === left.score ? left.option.id.localeCompare(right.option.id) : right.score - left.score));

    const winner = viable[0];
    const runnerUp = viable[1];
    const margin = winner === undefined ? 0 : winner.score - (runnerUp?.score ?? 0);
    const decisiveMargin = request.decisiveMargin ?? 0.1;

    const confidence =
      winner === undefined ? 0 : Math.max(0, Math.min(1, winner.score * 0.5 + Math.min(1, margin / decisiveMargin) * 0.5));

    const decision: Decision = {
      id: createId('decision'),
      selected: winner?.option,
      confidence,
      scores,
      rationale: this.buildRationale(winner, runnerUp, scores, request.criteria),
      decidedAt: this.clock.timestamp()
    };

    this.history.push(decision);
    return decision;
  }

  /** Chronological record of every decision this engine has made. */
  public getHistory(): readonly Decision[] {
    return [...this.history];
  }

  public clearHistory(): void {
    this.history.length = 0;
  }

  private buildRationale(
    winner: OptionScore | undefined,
    runnerUp: OptionScore | undefined,
    scores: readonly OptionScore[],
    criteria: readonly DecisionCriterion[]
  ): string {
    const eliminated = scores.filter((entry) => entry.eliminated);
    if (winner === undefined) {
      const reasons = eliminated.map((entry) => `${entry.option.label}: ${entry.eliminationReason ?? 'eliminated'}`);
      return `No option satisfied the constraints. ${reasons.join('; ')}`;
    }

    const contributions = criteria
      .map((criterion) => ({ criterion, value: (winner.normalized[criterion.id] ?? 0) * criterion.weight }))
      .sort((left, right) => right.value - left.value);
    const strongest = contributions[0];

    const parts = [`Selected "${winner.option.label}" with a weighted score of ${winner.score.toFixed(3)}.`];
    if (strongest !== undefined) {
      parts.push(`The dominant factor was "${strongest.criterion.id}" (${strongest.criterion.direction}).`);
    }
    if (runnerUp !== undefined) {
      parts.push(`It leads "${runnerUp.option.label}" by ${(winner.score - runnerUp.score).toFixed(3)}.`);
    }
    if (eliminated.length > 0) {
      parts.push(`${eliminated.length} option(s) were eliminated by constraints or thresholds.`);
    }
    return parts.join(' ');
  }
}
