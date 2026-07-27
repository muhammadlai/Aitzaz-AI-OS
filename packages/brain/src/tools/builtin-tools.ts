import type { JsonObject, JsonValue } from '@nexus/core';
import { invalidArgument } from '../errors/index.js';
import type { KnowledgeGraph } from '../knowledge/index.js';
import type { PersistentMemoryEngine } from '../memory/index.js';
import type { MemoryKind } from '../memory/index.js';
import type { Tool } from './tool-registry.js';

const asObject = (value: JsonValue): Readonly<Record<string, JsonValue>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidArgument('Tool input must be an object');
  }
  return value as Readonly<Record<string, JsonValue>>;
};

/** Stores a memory in a namespace. */
export const createMemoryWriteTool = (memory: PersistentMemoryEngine): Tool => ({
  name: 'memory_write',
  description: 'Persist a piece of information into long-term memory for later recall.',
  tags: ['memory'],
  idempotent: false,
  inputSchema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'Memory namespace to write into', minLength: 1 },
      content: { type: 'string', description: 'The information to remember', minLength: 1 },
      kind: { type: 'string', description: 'Memory category', enum: ['episodic', 'semantic', 'procedural', 'working'] },
      importance: { type: 'number', description: 'Relative importance from 0 to 1', minimum: 0, maximum: 1 }
    },
    required: ['namespace', 'content'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: { id: { type: 'string' }, stored: { type: 'boolean' } },
    required: ['id', 'stored']
  },
  execute: async (input) => {
    const object = asObject(input);
    const record = await memory.remember({
      namespace: String(object['namespace']),
      content: String(object['content']),
      kind: (object['kind'] as MemoryKind | undefined) ?? 'semantic',
      ...(typeof object['importance'] === 'number' ? { importance: object['importance'] } : {})
    });
    return { id: record.id, stored: true };
  }
});

/** Searches stored memories. */
export const createMemorySearchTool = (memory: PersistentMemoryEngine): Tool => ({
  name: 'memory_search',
  description: 'Search long-term memory for information relevant to a query.',
  tags: ['memory'],
  idempotent: true,
  inputSchema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'Memory namespace to search', minLength: 1 },
      query: { type: 'string', description: 'Free-text search query' },
      limit: { type: 'integer', description: 'Maximum results to return', minimum: 1, maximum: 50 }
    },
    required: ['namespace'],
    additionalProperties: false
  },
  execute: async (input) => {
    const object = asObject(input);
    const records = await memory.search({
      namespace: String(object['namespace']),
      ...(typeof object['query'] === 'string' ? { text: object['query'] } : {}),
      ...(typeof object['limit'] === 'number' ? { limit: object['limit'] } : {})
    });
    return records.map((record) => ({
      id: record.id,
      content: record.content,
      kind: record.kind,
      importance: record.importance
    })) as unknown as JsonValue;
  }
});

/** Queries the knowledge graph for nodes and their neighbours. */
export const createKnowledgeQueryTool = (graph: KnowledgeGraph): Tool => ({
  name: 'knowledge_query',
  description: 'Look up entities in the knowledge graph and inspect their relationships.',
  tags: ['knowledge'],
  idempotent: true,
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', description: 'Restrict results to this node type' },
      label: { type: 'string', description: 'Restrict results to this exact label' },
      includeNeighbors: { type: 'boolean', description: 'Include directly connected nodes' },
      limit: { type: 'integer', minimum: 1, maximum: 100 }
    },
    additionalProperties: false
  },
  execute: async (input) => {
    const object = asObject(input);
    const nodes = graph.findNodes({
      ...(typeof object['type'] === 'string' ? { type: object['type'] } : {}),
      ...(typeof object['label'] === 'string' ? { label: object['label'] } : {}),
      ...(typeof object['limit'] === 'number' ? { limit: object['limit'] } : {})
    });
    const includeNeighbors = object['includeNeighbors'] === true;
    return nodes.map((node) => ({
      id: node.id,
      type: node.type,
      label: node.label,
      properties: node.properties,
      ...(includeNeighbors
        ? { neighbors: graph.neighbors(node.id, 'both').map((neighbor) => ({ id: neighbor.id, label: neighbor.label })) }
        : {})
    })) as unknown as JsonValue;
  }
});

/** Evaluates a restricted arithmetic expression. */
export const createCalculatorTool = (): Tool => ({
  name: 'calculator',
  description: 'Evaluate a basic arithmetic expression using +, -, *, /, parentheses, and decimal numbers.',
  tags: ['utility'],
  idempotent: true,
  inputSchema: {
    type: 'object',
    properties: { expression: { type: 'string', description: 'Arithmetic expression to evaluate', minLength: 1, maxLength: 512 } },
    required: ['expression'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: { result: { type: 'number' }, expression: { type: 'string' } },
    required: ['result', 'expression']
  },
  execute: async (input) => {
    const object = asObject(input);
    const expression = String(object['expression']);
    return { expression, result: evaluateArithmetic(expression) };
  }
});

/**
 * Recursive-descent arithmetic evaluator.
 *
 * A dedicated parser is used rather than `eval` or `Function` so untrusted
 * model output can never execute arbitrary code.
 */
export const evaluateArithmetic = (expression: string): number => {
  const tokens = expression.match(/\d+\.?\d*|[+\-*/()]/g);
  if (tokens === null || tokens.join('').replace(/\s/g, '') !== expression.replace(/\s/g, '')) {
    throw invalidArgument('Expression contains unsupported characters');
  }

  let position = 0;
  const peek = (): string | undefined => tokens[position];
  const consume = (): string => {
    const token = tokens[position];
    if (token === undefined) throw invalidArgument('Unexpected end of expression');
    position += 1;
    return token;
  };

  const parseExpression = (): number => {
    let value = parseTerm();
    while (peek() === '+' || peek() === '-') {
      value = consume() === '+' ? value + parseTerm() : value - parseTerm();
    }
    return value;
  };

  const parseTerm = (): number => {
    let value = parseFactor();
    while (peek() === '*' || peek() === '/') {
      if (consume() === '*') {
        value *= parseFactor();
      } else {
        const divisor = parseFactor();
        if (divisor === 0) throw invalidArgument('Division by zero');
        value /= divisor;
      }
    }
    return value;
  };

  const parseFactor = (): number => {
    const token = consume();
    if (token === '-') return -parseFactor();
    if (token === '+') return parseFactor();
    if (token === '(') {
      const value = parseExpression();
      if (consume() !== ')') throw invalidArgument('Unbalanced parentheses');
      return value;
    }
    const value = Number(token);
    if (!Number.isFinite(value)) throw invalidArgument(`Unexpected token "${token}"`);
    return value;
  };

  const result = parseExpression();
  if (position !== tokens.length) throw invalidArgument('Unexpected trailing input in expression');
  if (!Number.isFinite(result)) throw invalidArgument('Expression did not evaluate to a finite number');
  return result;
};

/** Returns the current time, useful for grounding time-sensitive reasoning. */
export const createClockTool = (now: () => string = () => new Date().toISOString()): Tool => ({
  name: 'current_time',
  description: 'Return the current UTC timestamp in ISO 8601 format.',
  tags: ['utility'],
  idempotent: true,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object', properties: { timestamp: { type: 'string' } }, required: ['timestamp'] },
  execute: async (): Promise<JsonObject> => ({ timestamp: now() })
});
