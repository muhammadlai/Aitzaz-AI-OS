import type { JsonObject } from '@nexus/core';
import { invalidArgument } from '../errors/index.js';
import type { PersistentMemoryEngine } from '../memory/index.js';
import type { KnowledgeGraph } from '../knowledge/index.js';
import type { BrainContext, Message } from '../types/index.js';

/** Provenance of a context fragment, used for prioritization and auditing. */
export type FragmentSource = 'instruction' | 'memory' | 'knowledge' | 'conversation' | 'tool' | 'custom';

/** A single unit of context competing for space in the working window. */
export interface ContextFragment {
  readonly id: string;
  readonly source: FragmentSource;
  readonly content: string;
  readonly priority: number;
  readonly tokens: number;
  readonly metadata: JsonObject;
}

/** The assembled window returned to a reasoning or generation step. */
export interface AssembledContext {
  readonly fragments: readonly ContextFragment[];
  readonly text: string;
  readonly totalTokens: number;
  readonly budget: number;
  readonly droppedFragments: readonly ContextFragment[];
}

/** Estimates how many tokens a string occupies. */
export interface TokenEstimator {
  estimate(text: string): number;
}

/**
 * Heuristic estimator averaging ~4 characters per token, which tracks common
 * BPE tokenizers closely enough for budgeting without a tokenizer dependency.
 */
export class HeuristicTokenEstimator implements TokenEstimator {
  public constructor(private readonly charactersPerToken = 4) {
    if (!Number.isFinite(charactersPerToken) || charactersPerToken <= 0) {
      throw invalidArgument('charactersPerToken must be a positive number');
    }
  }

  public estimate(text: string): number {
    if (text.length === 0) return 0;
    const words = text.trim().split(/\s+/).length;
    return Math.max(1, Math.ceil(Math.max(text.length / this.charactersPerToken, words)));
  }
}

export interface ContextEngineOptions {
  readonly budget?: number;
  readonly estimator?: TokenEstimator;
  readonly memory?: PersistentMemoryEngine;
  readonly graph?: KnowledgeGraph;
}

export interface ContextRequest {
  readonly context: BrainContext;
  readonly instructions?: readonly string[];
  readonly messages?: readonly Message[];
  readonly memoryNamespace?: string;
  readonly memoryQuery?: string;
  readonly memoryLimit?: number;
  readonly knowledgeNodeIds?: readonly string[];
  readonly knowledgeDepth?: number;
  readonly custom?: readonly ContextFragment[];
  readonly budget?: number;
}

const SOURCE_WEIGHT: Readonly<Record<FragmentSource, number>> = {
  instruction: 1_000,
  conversation: 800,
  memory: 600,
  knowledge: 500,
  tool: 400,
  custom: 300
};

/**
 * Assembles the working context for a cognition step.
 *
 * Fragments are gathered from instructions, conversation history, persistent
 * memory, and the knowledge graph, then packed into a token budget by
 * descending priority. Anything that does not fit is reported rather than
 * silently discarded so callers can observe truncation.
 */
export class ContextEngine {
  private readonly estimator: TokenEstimator;
  private readonly defaultBudget: number;
  private readonly memory: PersistentMemoryEngine | undefined;
  private readonly graph: KnowledgeGraph | undefined;

  public constructor(options: ContextEngineOptions = {}) {
    this.estimator = options.estimator ?? new HeuristicTokenEstimator();
    this.defaultBudget = options.budget ?? 8_000;
    this.memory = options.memory;
    this.graph = options.graph;
    if (!Number.isInteger(this.defaultBudget) || this.defaultBudget < 1) {
      throw invalidArgument('Context budget must be a positive integer');
    }
  }

  /** Builds a context fragment, computing its token cost. */
  public createFragment(
    source: FragmentSource,
    content: string,
    options: { readonly id?: string; readonly priority?: number; readonly metadata?: JsonObject } = {}
  ): ContextFragment {
    return {
      id: options.id ?? `${source}:${content.slice(0, 24)}`,
      source,
      content,
      priority: options.priority ?? SOURCE_WEIGHT[source],
      tokens: this.estimator.estimate(content),
      metadata: options.metadata ?? {}
    };
  }

  /** Gathers, ranks, and packs context from all configured providers. */
  public async assemble(request: ContextRequest): Promise<AssembledContext> {
    const budget = request.budget ?? this.defaultBudget;
    if (!Number.isInteger(budget) || budget < 1) throw invalidArgument('Context budget must be a positive integer');

    const fragments: ContextFragment[] = [];

    for (const [index, instruction] of (request.instructions ?? []).entries()) {
      fragments.push(
        this.createFragment('instruction', instruction, {
          id: `instruction:${index}`,
          priority: SOURCE_WEIGHT.instruction - index
        })
      );
    }

    const messages = request.messages ?? [];
    messages.forEach((message, index) => {
      // Recent turns matter more, so priority rises toward the end of the transcript.
      const recencyBonus = index - messages.length;
      fragments.push(
        this.createFragment('conversation', `${message.role}: ${message.content}`, {
          id: `message:${message.id}`,
          priority: SOURCE_WEIGHT.conversation + recencyBonus,
          metadata: { role: message.role, messageId: message.id }
        })
      );
    });

    if (this.memory !== undefined && request.memoryNamespace !== undefined) {
      const records = await this.memory.search({
        namespace: request.memoryNamespace,
        ...(request.memoryQuery === undefined ? {} : { text: request.memoryQuery }),
        limit: request.memoryLimit ?? 8
      });
      for (const record of records) {
        fragments.push(
          this.createFragment('memory', record.content, {
            id: `memory:${record.id}`,
            priority: SOURCE_WEIGHT.memory + Math.round(record.importance * 100),
            metadata: { memoryId: record.id, kind: record.kind }
          })
        );
      }
    }

    if (this.graph !== undefined && request.knowledgeNodeIds !== undefined) {
      for (const nodeId of request.knowledgeNodeIds) {
        const node = this.graph.getNode(nodeId);
        if (node === undefined) continue;
        fragments.push(
          this.createFragment('knowledge', `${node.type} ${node.label}: ${JSON.stringify(node.properties)}`, {
            id: `knowledge:${node.id}`,
            metadata: { nodeId: node.id, nodeType: node.type }
          })
        );
        for (const related of this.graph.traverse(nodeId, { maxDepth: request.knowledgeDepth ?? 1, direction: 'both' })) {
          fragments.push(
            this.createFragment('knowledge', `${related.type} ${related.label}: ${JSON.stringify(related.properties)}`, {
              id: `knowledge:${related.id}`,
              priority: SOURCE_WEIGHT.knowledge - 50,
              metadata: { nodeId: related.id, nodeType: related.type }
            })
          );
        }
      }
    }

    fragments.push(...(request.custom ?? []));
    return this.pack(this.deduplicate(fragments), budget);
  }

  /** Packs pre-built fragments into a budget without gathering new ones. */
  public pack(fragments: readonly ContextFragment[], budget: number): AssembledContext {
    const ordered = [...fragments].sort((left, right) =>
      right.priority === left.priority ? left.id.localeCompare(right.id) : right.priority - left.priority
    );

    const selected: ContextFragment[] = [];
    const dropped: ContextFragment[] = [];
    let used = 0;

    for (const fragment of ordered) {
      if (used + fragment.tokens <= budget) {
        selected.push(fragment);
        used += fragment.tokens;
      } else {
        dropped.push(fragment);
      }
    }

    return {
      fragments: selected,
      text: selected.map((fragment) => fragment.content).join('\n\n'),
      totalTokens: used,
      budget,
      droppedFragments: dropped
    };
  }

  private deduplicate(fragments: readonly ContextFragment[]): readonly ContextFragment[] {
    const seen = new Map<string, ContextFragment>();
    for (const fragment of fragments) {
      const key = `${fragment.source}|${fragment.content}`;
      const existing = seen.get(key);
      if (existing === undefined || fragment.priority > existing.priority) seen.set(key, fragment);
    }
    return [...seen.values()];
  }
}
