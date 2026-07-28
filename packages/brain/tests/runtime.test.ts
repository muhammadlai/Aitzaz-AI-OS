import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgentRegistry, MultiAgentRuntime } from '../src/agents/index.js';
import { BrainEventBus } from '../src/events/index.js';
import { KnowledgeGraph } from '../src/knowledge/index.js';
import { BrainTaskScheduler } from '../src/scheduler/index.js';
import { ToolRegistry } from '../src/tools/index.js';
import { AutonomousRuntime, DynamicAgentLoader, KnowledgeRetriever, RuntimeStreamHub, WebSocketRuntimeBridge } from '../src/runtime/index.js';
import { clockAt, makeAgent } from './helpers.js';

describe('Phase 3 autonomous runtime', () => {
  it('loads only allow-listed agents and executes queued tasks with live events', async () => {
    const clock = clockAt(); const registry = new AgentRegistry(clock); const events = new BrainEventBus({ clock });
    const tools = new ToolRegistry({ clock }); const agents = new MultiAgentRuntime({ registry, tools, events, clock });
    const scheduler = new BrainTaskScheduler({ clock }); const graph = new KnowledgeGraph(clock);
    graph.addNode({ id: 'release', type: 'document', label: 'Phase three release plan', properties: { team: 'runtime' } });
    const loader = new DynamicAgentLoader(); loader.register('planner', () => makeAgent('planner', ['plan'], (task) => ({ output: { goal: task.goal } })));
    await loader.load('planner', registry);
    const hub = new RuntimeStreamHub(); const seen: string[] = []; hub.subscribe((event) => seen.push(event.type));
    const runtime = new AutonomousRuntime({ agents, scheduler, events, loader, knowledge: new KnowledgeRetriever(graph), streams: hub, clock });
    const receipt = runtime.submit({ goal: 'ship phase three', capabilities: ['plan'] });
    const jobs = await runtime.drain();
    assert.equal(jobs.length, 1); assert.deepEqual((jobs[0] as { result: { output: unknown } }).result.output, { goal: 'ship phase three' });
    assert.equal(receipt.task.id, receipt.id); assert.deepEqual(runtime.retrieve('release runtime').map((hit) => hit.node.id), ['release']);
    assert.deepEqual(seen, ['task.queued', 'task.started', 'task.completed']);
  });
  it('replays streams to WebSocket-shaped peers and isolates untrusted module names', () => {
    const hub = new RuntimeStreamHub(); hub.publish('ready', { ok: true }); const sent: string[] = [];
    const bridge = new WebSocketRuntimeBridge(); const subscription = bridge.attach({ readyState: 1, send: (data) => sent.push(data) }, hub);
    hub.publish('update', { count: 1 }); subscription.close(); hub.publish('ignored', {});
    assert.equal(sent.length, 1); assert.match(sent[0] ?? '', /update/);
    const loader = new DynamicAgentLoader(); assert.throws(() => loader.register('../unsafe', () => { throw new Error('never'); }), /Invalid/);
  });
});
