import { createId, type JsonObject } from '@nexus/core';
import { duplicate, invalidArgument, notFound } from '../errors/index.js';
import { SystemClock, type Clock } from '../types/index.js';

/** A typed node in the knowledge graph. */
export interface GraphNode {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly properties: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A directed, typed, weighted edge between two nodes. */
export interface GraphEdge {
  readonly id: string;
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly weight: number;
  readonly properties: JsonObject;
  readonly createdAt: string;
}

/** Filter used when querying nodes. */
export interface NodeQuery {
  readonly type?: string;
  readonly label?: string;
  readonly properties?: JsonObject;
  readonly limit?: number;
}

/** Filter used when traversing edges. */
export interface EdgeQuery {
  readonly type?: string;
  readonly from?: string;
  readonly to?: string;
  readonly minWeight?: number;
}

/** A discovered route between two nodes. */
export interface GraphPath {
  readonly nodes: readonly string[];
  readonly edges: readonly GraphEdge[];
  readonly totalWeight: number;
}

/** Direction of traversal for neighbourhood queries. */
export type TraversalDirection = 'outgoing' | 'incoming' | 'both';

/**
 * In-memory property graph supporting typed nodes, weighted directed edges,
 * breadth-first traversal, and weighted shortest paths.
 *
 * Adjacency is maintained incrementally so neighbourhood queries stay O(degree)
 * rather than scanning every edge.
 */
export class KnowledgeGraph {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, GraphEdge>();
  private readonly outgoing = new Map<string, Set<string>>();
  private readonly incoming = new Map<string, Set<string>>();
  private readonly clock: Clock;

  public constructor(clock: Clock = new SystemClock()) {
    this.clock = clock;
  }

  /** Inserts a node, rejecting duplicate identifiers. */
  public addNode(input: {
    readonly id?: string;
    readonly type: string;
    readonly label: string;
    readonly properties?: JsonObject;
  }): GraphNode {
    if (input.type.trim() === '') throw invalidArgument('Node type must not be empty');
    if (input.label.trim() === '') throw invalidArgument('Node label must not be empty');
    const id = input.id ?? createId('node');
    if (this.nodes.has(id)) throw duplicate('Graph node', id);
    const now = this.clock.timestamp();
    const node: GraphNode = {
      id,
      type: input.type,
      label: input.label,
      properties: input.properties ?? {},
      createdAt: now,
      updatedAt: now
    };
    this.nodes.set(id, node);
    this.outgoing.set(id, new Set());
    this.incoming.set(id, new Set());
    return node;
  }

  /** Inserts a node or merges properties into an existing one. */
  public upsertNode(input: {
    readonly id: string;
    readonly type: string;
    readonly label: string;
    readonly properties?: JsonObject;
  }): GraphNode {
    const existing = this.nodes.get(input.id);
    if (existing === undefined) return this.addNode(input);
    const merged: GraphNode = {
      ...existing,
      type: input.type,
      label: input.label,
      properties: { ...existing.properties, ...(input.properties ?? {}) },
      updatedAt: this.clock.timestamp()
    };
    this.nodes.set(input.id, merged);
    return merged;
  }

  public getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  public requireNode(id: string): GraphNode {
    const node = this.nodes.get(id);
    if (node === undefined) throw notFound('Graph node', id);
    return node;
  }

  /** Removes a node together with every edge that touches it. */
  public removeNode(id: string): boolean {
    if (!this.nodes.has(id)) return false;
    for (const edgeId of [...(this.outgoing.get(id) ?? []), ...(this.incoming.get(id) ?? [])]) {
      this.removeEdge(edgeId);
    }
    this.outgoing.delete(id);
    this.incoming.delete(id);
    return this.nodes.delete(id);
  }

  /** Connects two existing nodes with a typed, weighted edge. */
  public addEdge(input: {
    readonly id?: string;
    readonly type: string;
    readonly from: string;
    readonly to: string;
    readonly weight?: number;
    readonly properties?: JsonObject;
  }): GraphEdge {
    if (input.type.trim() === '') throw invalidArgument('Edge type must not be empty');
    this.requireNode(input.from);
    this.requireNode(input.to);
    const weight = input.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) throw invalidArgument('Edge weight must be a positive finite number');
    const id = input.id ?? createId('edge');
    if (this.edges.has(id)) throw duplicate('Graph edge', id);

    const edge: GraphEdge = {
      id,
      type: input.type,
      from: input.from,
      to: input.to,
      weight,
      properties: input.properties ?? {},
      createdAt: this.clock.timestamp()
    };
    this.edges.set(id, edge);
    this.outgoing.get(input.from)?.add(id);
    this.incoming.get(input.to)?.add(id);
    return edge;
  }

  public getEdge(id: string): GraphEdge | undefined {
    return this.edges.get(id);
  }

  public removeEdge(id: string): boolean {
    const edge = this.edges.get(id);
    if (edge === undefined) return false;
    this.outgoing.get(edge.from)?.delete(id);
    this.incoming.get(edge.to)?.delete(id);
    return this.edges.delete(id);
  }

  /** Finds nodes matching a structured filter. */
  public findNodes(query: NodeQuery = {}): readonly GraphNode[] {
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1) throw invalidArgument('Node query limit must be a positive integer');
    const results: GraphNode[] = [];
    for (const node of this.nodes.values()) {
      if (query.type !== undefined && node.type !== query.type) continue;
      if (query.label !== undefined && node.label !== query.label) continue;
      if (query.properties !== undefined) {
        const matches = Object.entries(query.properties).every(
          ([key, value]) => JSON.stringify(node.properties[key]) === JSON.stringify(value)
        );
        if (!matches) continue;
      }
      results.push(node);
      if (results.length >= limit) break;
    }
    return results;
  }

  /** Lists edges matching a structured filter. */
  public findEdges(query: EdgeQuery = {}): readonly GraphEdge[] {
    return [...this.edges.values()].filter((edge) => {
      if (query.type !== undefined && edge.type !== query.type) return false;
      if (query.from !== undefined && edge.from !== query.from) return false;
      if (query.to !== undefined && edge.to !== query.to) return false;
      if (query.minWeight !== undefined && edge.weight < query.minWeight) return false;
      return true;
    });
  }

  /** Returns the nodes directly connected to a node in the requested direction. */
  public neighbors(id: string, direction: TraversalDirection = 'outgoing', edgeType?: string): readonly GraphNode[] {
    this.requireNode(id);
    const collected = new Map<string, GraphNode>();
    for (const edge of this.adjacentEdges(id, direction)) {
      if (edgeType !== undefined && edge.type !== edgeType) continue;
      const neighborId = edge.from === id ? edge.to : edge.from;
      const node = this.nodes.get(neighborId);
      if (node !== undefined) collected.set(node.id, node);
    }
    return [...collected.values()];
  }

  /** Breadth-first traversal returning every node reachable within `maxDepth`. */
  public traverse(
    startId: string,
    options: { readonly maxDepth?: number; readonly direction?: TraversalDirection; readonly edgeType?: string } = {}
  ): readonly GraphNode[] {
    this.requireNode(startId);
    const maxDepth = options.maxDepth ?? 2;
    if (!Number.isInteger(maxDepth) || maxDepth < 0) throw invalidArgument('maxDepth must be a non-negative integer');

    const visited = new Set<string>([startId]);
    const ordered: GraphNode[] = [];
    let frontier: string[] = [startId];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const current of frontier) {
        for (const neighbor of this.neighbors(current, options.direction ?? 'outgoing', options.edgeType)) {
          if (visited.has(neighbor.id)) continue;
          visited.add(neighbor.id);
          ordered.push(neighbor);
          next.push(neighbor.id);
        }
      }
      frontier = next;
    }
    return ordered;
  }

  /**
   * Weighted shortest path via Dijkstra's algorithm. Returns `undefined` when
   * the target is unreachable.
   */
  public shortestPath(fromId: string, toId: string, direction: TraversalDirection = 'outgoing'): GraphPath | undefined {
    this.requireNode(fromId);
    this.requireNode(toId);
    if (fromId === toId) return { nodes: [fromId], edges: [], totalWeight: 0 };

    const distances = new Map<string, number>([[fromId, 0]]);
    const previous = new Map<string, GraphEdge>();
    const unvisited = new Set<string>(this.nodes.keys());

    while (unvisited.size > 0) {
      let current: string | undefined;
      let best = Number.POSITIVE_INFINITY;
      for (const candidate of unvisited) {
        const distance = distances.get(candidate) ?? Number.POSITIVE_INFINITY;
        if (distance < best) {
          best = distance;
          current = candidate;
        }
      }
      if (current === undefined || best === Number.POSITIVE_INFINITY) break;
      if (current === toId) break;
      unvisited.delete(current);

      for (const edge of this.adjacentEdges(current, direction)) {
        const neighborId = edge.from === current ? edge.to : edge.from;
        if (!unvisited.has(neighborId)) continue;
        const candidateDistance = best + edge.weight;
        if (candidateDistance < (distances.get(neighborId) ?? Number.POSITIVE_INFINITY)) {
          distances.set(neighborId, candidateDistance);
          previous.set(neighborId, edge);
        }
      }
    }

    if (!distances.has(toId)) return undefined;

    const path: string[] = [toId];
    const usedEdges: GraphEdge[] = [];
    let cursor = toId;
    while (cursor !== fromId) {
      const edge = previous.get(cursor);
      if (edge === undefined) return undefined;
      usedEdges.unshift(edge);
      cursor = edge.from === cursor ? edge.to : edge.from;
      path.unshift(cursor);
    }

    return { nodes: path, edges: usedEdges, totalWeight: distances.get(toId) as number };
  }

  /** Serializable snapshot of the whole graph. */
  public snapshot(): { readonly nodes: readonly GraphNode[]; readonly edges: readonly GraphEdge[] } {
    return { nodes: [...this.nodes.values()], edges: [...this.edges.values()] };
  }

  /** Replaces graph contents from a snapshot produced by `snapshot()`. */
  public restore(snapshot: { readonly nodes: readonly GraphNode[]; readonly edges: readonly GraphEdge[] }): void {
    this.nodes.clear();
    this.edges.clear();
    this.outgoing.clear();
    this.incoming.clear();
    for (const node of snapshot.nodes) {
      this.nodes.set(node.id, node);
      this.outgoing.set(node.id, new Set());
      this.incoming.set(node.id, new Set());
    }
    for (const edge of snapshot.edges) {
      if (!this.nodes.has(edge.from) || !this.nodes.has(edge.to)) continue;
      this.edges.set(edge.id, edge);
      this.outgoing.get(edge.from)?.add(edge.id);
      this.incoming.get(edge.to)?.add(edge.id);
    }
  }

  public get nodeCount(): number {
    return this.nodes.size;
  }

  public get edgeCount(): number {
    return this.edges.size;
  }

  private adjacentEdges(id: string, direction: TraversalDirection): readonly GraphEdge[] {
    const ids =
      direction === 'outgoing'
        ? [...(this.outgoing.get(id) ?? [])]
        : direction === 'incoming'
          ? [...(this.incoming.get(id) ?? [])]
          : [...(this.outgoing.get(id) ?? []), ...(this.incoming.get(id) ?? [])];
    return ids.flatMap((edgeId) => {
      const edge = this.edges.get(edgeId);
      return edge === undefined ? [] : [edge];
    });
  }
}
