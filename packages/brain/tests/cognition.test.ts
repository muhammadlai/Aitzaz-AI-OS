import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DecisionEngine, type DecisionOption } from '../src/decision/index.js';
import { PlanningEngine } from '../src/planning/index.js';
import { ReasoningEngine, type Fact } from '../src/reasoning/index.js';
import { clockAt, testContext } from './helpers.js';

describe('ReasoningEngine', () => {
  const mortalityEngine = (): ReasoningEngine => {
    const engine = new ReasoningEngine({ clock: clockAt() });
    engine.addRule({
      id: 'modus-ponens',
      description: 'All humans are mortal',
      strategy: 'deductive',
      matches: (facts) => {
        const human = facts.find((fact) => fact.statement === 'Socrates is human');
        return human === undefined ? undefined : [human.id];
      },
      derive: () => ({ statement: 'Socrates is mortal', confidence: 1 })
    });
    return engine;
  };

  it('derives a conclusion by forward chaining', async () => {
    const engine = mortalityEngine();
    const result = await engine.infer(testContext(), [ReasoningEngine.fact('Socrates is human')]);

    assert.equal(result.conclusion, 'Socrates is mortal');
    assert.equal(result.steps.length, 1);
    assert.equal(result.derivedFacts.length, 1);
  });

  it('stops as soon as the goal is proven', async () => {
    const engine = mortalityEngine();
    const result = await engine.infer(testContext(), [ReasoningEngine.fact('Socrates is human')], {
      goal: 'Socrates is mortal'
    });

    assert.equal(result.conclusion, 'Socrates is mortal');
    assert.equal(result.exhausted, false);
  });

  it('never exceeds the weakest premise confidence', async () => {
    const engine = mortalityEngine();
    const result = await engine.infer(testContext(), [ReasoningEngine.fact('Socrates is human', 0.6)]);

    assert.ok((result.confidence ?? 0) <= 0.6 + 1e-9, 'derived confidence must be capped by its premises');
  });

  it('does not loop forever on a self-satisfying rule', async () => {
    const engine = new ReasoningEngine({ clock: clockAt(), maxIterations: 5 });
    let counter = 0;
    engine.addRule({
      id: 'generator',
      description: 'Always produces a new fact',
      strategy: 'inductive',
      matches: (facts) => (facts[0] === undefined ? undefined : [facts[0].id]),
      derive: () => {
        counter += 1;
        return { statement: `derived-${counter}`, confidence: 0.9 };
      }
    });

    const result = await engine.infer(testContext(), [ReasoningEngine.fact('seed')]);
    assert.ok(result.iterations <= 5, 'iteration cap must bound the run');
  });

  it('reports no conclusion when no rule applies', async () => {
    const engine = mortalityEngine();
    const result = await engine.infer(testContext(), [ReasoningEngine.fact('Plato is a philosopher')]);

    assert.equal(result.conclusion, undefined);
    assert.equal(result.steps.length, 0);
    assert.match(engine.explain(result), /No inferences/);
  });

  it('rejects malformed facts', () => {
    assert.throws(() => ReasoningEngine.fact(''), /must not be empty/);
    assert.throws(() => ReasoningEngine.fact('x', 2), /between 0 and 1/);
  });

  it('renders an explanation of every step', async () => {
    const engine = mortalityEngine();
    const result = await engine.infer(testContext(), [ReasoningEngine.fact('Socrates is human')]);

    const explanation = engine.explain(result);
    assert.match(explanation, /modus-ponens/);
    assert.match(explanation, /Conclusion: Socrates is mortal/);
  });
});

describe('PlanningEngine', () => {
  const drafts = [
    { id: 'gather', name: 'Gather data', action: 'collect', estimatedCost: 2 },
    { id: 'analyze', name: 'Analyze', action: 'analyze', dependsOn: ['gather'], estimatedCost: 3 },
    { id: 'notify', name: 'Notify', action: 'notify', dependsOn: ['gather'], estimatedCost: 1 },
    { id: 'report', name: 'Report', action: 'report', dependsOn: ['analyze', 'notify'], estimatedCost: 1 }
  ];

  it('compiles a valid dependency graph', () => {
    const engine = new PlanningEngine({ clock: clockAt() });
    const plan = engine.compile('Ship the report', drafts);

    assert.equal(plan.steps.length, 4);
    assert.equal(plan.status, 'ready');
    assert.equal(plan.steps.find((step) => step.id === 'gather')?.status, 'ready');
    assert.equal(plan.steps.find((step) => step.id === 'report')?.status, 'pending');
  });

  it('groups independent steps into parallel levels', () => {
    const engine = new PlanningEngine({ clock: clockAt() });
    const plan = engine.compile('Ship the report', drafts);
    const levels = engine.levels(plan.id);

    assert.equal(levels.length, 3);
    assert.equal(levels[1]?.length, 2, 'analyze and notify are independent');
  });

  it('rejects dependency cycles and unknown dependencies', () => {
    const engine = new PlanningEngine({ clock: clockAt() });
    assert.throws(
      () =>
        engine.compile('cyclic', [
          { id: 'a', name: 'A', action: 'x', dependsOn: ['b'] },
          { id: 'b', name: 'B', action: 'x', dependsOn: ['a'] }
        ]),
      /dependency cycle/
    );
    assert.throws(() => engine.compile('missing', [{ id: 'a', name: 'A', action: 'x', dependsOn: ['ghost'] }]), /unknown step/);
  });

  it('advances step and plan status as work completes', () => {
    const engine = new PlanningEngine({ clock: clockAt() });
    const plan = engine.compile('Ship the report', drafts);

    engine.updateStep(plan.id, 'gather', { status: 'completed' });
    const afterGather = engine.getPlan(plan.id);
    assert.equal(afterGather.status, 'executing');
    assert.equal(afterGather.steps.find((step) => step.id === 'analyze')?.status, 'ready');

    for (const id of ['analyze', 'notify', 'report']) engine.updateStep(plan.id, id, { status: 'completed' });
    assert.equal(engine.getPlan(plan.id).status, 'completed');
  });

  it('marks a plan failed when any step fails', () => {
    const engine = new PlanningEngine({ clock: clockAt() });
    const plan = engine.compile('Ship the report', drafts);

    engine.updateStep(plan.id, 'gather', { status: 'failed', error: 'source unavailable' });
    assert.equal(engine.getPlan(plan.id).status, 'failed');
  });

  it('computes cost and the critical path', () => {
    const engine = new PlanningEngine({ clock: clockAt() });
    const plan = engine.compile('Ship the report', drafts);

    assert.equal(engine.estimateCost(plan.id), 7);
    assert.deepEqual(
      engine.criticalPath(plan.id).map((step) => step.id),
      ['gather', 'analyze', 'report']
    );
  });

  it('cancels a plan and skips unfinished steps', () => {
    const engine = new PlanningEngine({ clock: clockAt() });
    const plan = engine.compile('Ship the report', drafts);
    engine.updateStep(plan.id, 'gather', { status: 'completed' });

    const cancelled = engine.cancel(plan.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.steps.find((step) => step.id === 'gather')?.status, 'completed');
    assert.equal(cancelled.steps.find((step) => step.id === 'report')?.status, 'skipped');
  });

  it('builds plans from a registered strategy', async () => {
    const engine = new PlanningEngine({ clock: clockAt() });
    engine.registerStrategy({
      id: 'simple',
      description: 'One-step plan',
      plan: async (goal) => [{ id: 'only', name: goal, action: 'do' }]
    });

    const plan = await engine.createPlan('do the thing', testContext());
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.metadata['strategy'], 'simple');
  });

  it('fails when no strategy handles the goal', async () => {
    const engine = new PlanningEngine({ clock: clockAt() });
    engine.registerStrategy({ id: 'never', description: 'Declines', plan: async () => undefined });

    await assert.rejects(() => engine.createPlan('impossible', testContext()), /No planning strategy/);
  });
});

describe('DecisionEngine', () => {
  const options: readonly DecisionOption[] = [
    { id: 'fast', label: 'Fast option', attributes: { speed: 10, cost: 100 }, metadata: {} },
    { id: 'cheap', label: 'Cheap option', attributes: { speed: 2, cost: 10 }, metadata: {} },
    { id: 'balanced', label: 'Balanced option', attributes: { speed: 6, cost: 50 }, metadata: {} }
  ];

  it('selects the option maximizing weighted criteria', async () => {
    const engine = new DecisionEngine({ clock: clockAt() });
    const decision = await engine.decide({
      context: testContext(),
      options,
      criteria: [{ id: 'speed', attribute: 'speed', weight: 1, direction: 'maximize' }]
    });

    assert.equal(decision.selected?.id, 'fast');
    assert.ok(decision.confidence > 0);
  });

  it('honours minimize direction', async () => {
    const engine = new DecisionEngine({ clock: clockAt() });
    const decision = await engine.decide({
      context: testContext(),
      options,
      criteria: [{ id: 'cost', attribute: 'cost', weight: 1, direction: 'minimize' }]
    });

    assert.equal(decision.selected?.id, 'cheap');
  });

  it('eliminates options failing a hard constraint', async () => {
    const engine = new DecisionEngine({ clock: clockAt() });
    const decision = await engine.decide({
      context: testContext(),
      options,
      criteria: [{ id: 'speed', attribute: 'speed', weight: 1, direction: 'maximize' }],
      constraints: [{ id: 'budget', description: 'Cost must be under 60', permits: (option) => (option.attributes['cost'] ?? 0) < 60 }]
    });

    assert.equal(decision.selected?.id, 'balanced');
    assert.equal(decision.scores.filter((score) => score.eliminated).length, 1);
    assert.match(decision.rationale, /eliminated/);
  });

  it('returns no selection when every option is vetoed', async () => {
    const engine = new DecisionEngine({ clock: clockAt() });
    const decision = await engine.decide({
      context: testContext(),
      options,
      criteria: [{ id: 'speed', attribute: 'speed', weight: 1, direction: 'maximize' }],
      constraints: [{ id: 'impossible', description: 'Never satisfied', permits: () => false }]
    });

    assert.equal(decision.selected, undefined);
    assert.equal(decision.confidence, 0);
    assert.match(decision.rationale, /No option satisfied/);
  });

  it('balances competing weighted criteria', async () => {
    const engine = new DecisionEngine({ clock: clockAt() });
    const decision = await engine.decide({
      context: testContext(),
      options,
      criteria: [
        { id: 'speed', attribute: 'speed', weight: 1, direction: 'maximize' },
        { id: 'cost', attribute: 'cost', weight: 1, direction: 'minimize' }
      ]
    });

    assert.ok(decision.selected !== undefined);
    assert.equal(decision.scores.length, 3);
  });

  it('validates its inputs', async () => {
    const engine = new DecisionEngine({ clock: clockAt() });
    await assert.rejects(
      () => engine.decide({ context: testContext(), options: [], criteria: [{ id: 'a', attribute: 'a', weight: 1, direction: 'maximize' }] }),
      /At least one option/
    );
    await assert.rejects(() => engine.decide({ context: testContext(), options, criteria: [] }), /At least one criterion/);
  });

  it('records decision history', async () => {
    const engine = new DecisionEngine({ clock: clockAt() });
    await engine.decide({
      context: testContext(),
      options,
      criteria: [{ id: 'speed', attribute: 'speed', weight: 1, direction: 'maximize' }]
    });

    assert.equal(engine.getHistory().length, 1);
    engine.clearHistory();
    assert.equal(engine.getHistory().length, 0);
  });
});
