import { invalidArgument } from '../errors/index.js';
import type { Agent, AgentRegistry } from '../agents/index.js';

/** Trusted factory used to load an agent without evaluating a package name or URL. */
export type AgentFactory = () => Agent | Promise<Agent>;

/** Explicit allow-list loader for dynamically provisioned agents. */
export class DynamicAgentLoader {
  private readonly factories = new Map<string, AgentFactory>();

  public register(id: string, factory: AgentFactory): void {
    if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(id)) throw invalidArgument(`Invalid agent module id "${id}"`);
    if (this.factories.has(id)) throw invalidArgument(`Agent module "${id}" is already registered`);
    this.factories.set(id, factory);
  }

  public async load(id: string, registry: AgentRegistry): Promise<Agent> {
    const factory = this.factories.get(id);
    if (factory === undefined) throw invalidArgument(`Agent module "${id}" is not allow-listed`);
    const agent = await factory();
    if (agent.manifest.id !== id) throw invalidArgument(`Agent module "${id}" returned mismatched manifest "${agent.manifest.id}"`);
    registry.register(agent);
    return agent;
  }

  public modules(): readonly string[] { return [...this.factories.keys()].sort(); }
}
