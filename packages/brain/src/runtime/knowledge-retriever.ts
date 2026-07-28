import type { GraphNode, KnowledgeGraph } from '../knowledge/index.js';

export interface KnowledgeHit { readonly node: GraphNode; readonly score: number; }
/** Deterministic lexical retrieval over graph labels and JSON-safe properties. */
export class KnowledgeRetriever {
  public constructor(private readonly graph: KnowledgeGraph) {}
  public search(query: string, limit = 10): readonly KnowledgeHit[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0 || limit < 1) return [];
    return this.graph.findNodes().map((node) => {
      const text = `${node.label} ${node.type} ${JSON.stringify(node.properties)}`.toLowerCase();
      return { node, score: terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0) / terms.length };
    }).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id)).slice(0, limit);
  }
}
