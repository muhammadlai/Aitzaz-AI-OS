import { createId, type JsonObject } from '@nexus/core';
import { invalidArgument, notFound } from '../errors/index.js';
import { SystemClock, type BrainContext, type Clock, type Confidence } from '../types/index.js';
import { assertActive } from '../utils/index.js';

/** Reasoning strategies supported by the engine. */
export type ReasoningStrategy = 'deductive' | 'inductive' | 'abductive' | 'chain-of-thought';

/** A single step in a reasoning trace. */
export interface ReasoningStep {
  readonly index: number;
  readonly rule: string;
  readonly statement: string;
  readonly confidence: Confidence;
  readonly premises: readonly string[];
  readonly producedAt: string;
}

/** A fact supplied to or derived by the reasoning engine. */
export interface Fact {
  readonly id: string;
  readonly statement: string;
  readonly confidence: Confidence;
  readonly metadata: JsonObject;
}

/** A conditional rule evaluated against the working fact set. */
export interface InferenceRule {
  readonly id: string;
  readonly description: string;
  readonly strategy: ReasoningStrategy;
  /** Returns the premise ids satisfying this rule, or `undefined` when it does not apply. */
  readonly matches: (facts: readonly Fact[]) => readonly string[] | undefined;
  /** Produces the derived statement from matched premises. */
  readonly derive: (premises: readonly Fact[]) => { readonly statement: string; readonly confidence: Confidence };
}

/** Result of a reasoning run. */
export interface ReasoningResult {
  readonly id: string;
  readonly conclusion: string | undefined;
  readonly confidence: Confidence;
  readonly steps: readonly ReasoningStep[];
  readonly derivedFacts: readonly Fact[];
  readonly strategy: ReasoningStrategy;
  readonly iterations: number;
  readonly exhausted: boolean;
}

export interface ReasoningOptions {
  readonly clock?: Clock;
  readonly maxIterations?: number;
  readonly minConfidence?: number;
}

/**
 * Forward-chaining inference engine.
 *
 * Rules are applied repeatedly against the working set until no new facts
 * appear, the iteration cap is reached, or a goal is proven. Every derivation
 * is recorded as a step so conclusions remain fully explainable.
 */
export class ReasoningEngine {
  private readonly rules = new Map<string, InferenceRule>();
  private readonly clock: Clock;
  private readonly maxIterations: number;
  private readonly minConfidence: number;

  public constructor(options: ReasoningOptions = {}) {
    this.clock = options.clock ?? new SystemClock();
    this.maxIterations = options.maxIterations ?? 32;
    this.minConfidence = options.minConfidence ?? 0.1;
    if (!Number.isInteger(this.maxIterations) || this.maxIterations < 1) {
      throw invalidArgument('maxIterations must be a positive integer');
    }
  }

  /** Registers an inference rule. */
  public addRule(rule: InferenceRule): void {
    if (rule.id.trim() === '') throw invalidArgument('Rule id must not be empty');
    this.rules.set(rule.id, rule);
  }

  public removeRule(id: string): boolean {
    return this.rules.delete(id);
  }

  public getRule(id: string): InferenceRule {
    const rule = this.rules.get(id);
    if (rule === undefined) throw notFound('Inference rule', id);
    return rule;
  }

  public listRules(): readonly InferenceRule[] {
    return [...this.rules.values()];
  }

  /** Creates a fact with a validated confidence. */
  public static fact(statement: string, confidence: Confidence = 1, metadata: JsonObject = {}): Fact {
    if (statement.trim() === '') throw invalidArgument('Fact statement must not be empty');
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw invalidArgument('Fact confidence must be between 0 and 1');
    }
    return { id: createId('fact'), statement, confidence, metadata };
  }

  /**
   * Runs forward chaining over the supplied facts.
   *
   * When `goal` is provided the run stops as soon as a derived statement
   * matches it, which keeps goal-directed queries inexpensive.
   */
  public async infer(
    context: BrainContext,
    facts: readonly Fact[],
    options: { readonly goal?: string; readonly strategy?: ReasoningStrategy } = {}
  ): Promise<ReasoningResult> {
    const strategy = options.strategy ?? 'deductive';
    const working = new Map<string, Fact>(facts.map((fact) => [fact.id, fact]));
    const known = new Set<string>(facts.map((fact) => fact.statement));
    const steps: ReasoningStep[] = [];
    const derived: Fact[] = [];

    let iterations = 0;
    let conclusion: string | undefined;
    let conclusionConfidence = 0;
    let exhausted = true;

    for (; iterations < this.maxIterations; iterations += 1) {
      assertActive(context, 'Reasoning', this.clock.now());
      let producedThisPass = false;

      for (const rule of this.rules.values()) {
        if (options.strategy !== undefined && rule.strategy !== options.strategy) continue;

        const currentFacts = [...working.values()];
        const premiseIds = rule.matches(currentFacts);
        if (premiseIds === undefined || premiseIds.length === 0) continue;

        const premises = premiseIds.flatMap((id) => {
          const fact = working.get(id);
          return fact === undefined ? [] : [fact];
        });
        if (premises.length !== premiseIds.length) continue;

        const output = rule.derive(premises);
        if (known.has(output.statement)) continue;

        // Derived confidence never exceeds the weakest premise supporting it.
        const premiseConfidence = Math.min(...premises.map((premise) => premise.confidence));
        const confidence = Math.max(0, Math.min(1, output.confidence * premiseConfidence));
        if (confidence < this.minConfidence) continue;

        const fact: Fact = {
          id: createId('fact'),
          statement: output.statement,
          confidence,
          metadata: { rule: rule.id, premises: [...premiseIds] }
        };

        working.set(fact.id, fact);
        known.add(fact.statement);
        derived.push(fact);
        producedThisPass = true;

        steps.push({
          index: steps.length,
          rule: rule.id,
          statement: output.statement,
          confidence,
          premises: premises.map((premise) => premise.statement),
          producedAt: this.clock.timestamp()
        });

        if (options.goal !== undefined && output.statement === options.goal) {
          return {
            id: createId('reason'),
            conclusion: output.statement,
            confidence,
            steps,
            derivedFacts: derived,
            strategy,
            iterations: iterations + 1,
            exhausted: false
          };
        }

        if (confidence > conclusionConfidence) {
          conclusion = output.statement;
          conclusionConfidence = confidence;
        }
      }

      if (!producedThisPass) break;
      exhausted = false;
    }

    if (options.goal !== undefined && conclusion !== options.goal) {
      const proven = known.has(options.goal);
      return {
        id: createId('reason'),
        ...(proven ? { conclusion: options.goal } : { conclusion: undefined }),
        confidence: proven ? conclusionConfidence : 0,
        steps,
        derivedFacts: derived,
        strategy,
        iterations,
        exhausted: iterations >= this.maxIterations && exhausted
      };
    }

    return {
      id: createId('reason'),
      conclusion,
      confidence: conclusionConfidence,
      steps,
      derivedFacts: derived,
      strategy,
      iterations,
      exhausted: iterations >= this.maxIterations
    };
  }

  /** Renders a reasoning result as a human-readable explanation. */
  public explain(result: ReasoningResult): string {
    if (result.steps.length === 0) return 'No inferences were derived from the supplied facts.';
    const lines = result.steps.map(
      (step) =>
        `${step.index + 1}. [${step.rule}] ${step.premises.join(' AND ')} => ${step.statement} (confidence ${step.confidence.toFixed(2)})`
    );
    const summary =
      result.conclusion === undefined
        ? 'No conclusion reached.'
        : `Conclusion: ${result.conclusion} (confidence ${result.confidence.toFixed(2)})`;
    return [...lines, summary].join('\n');
  }
}
