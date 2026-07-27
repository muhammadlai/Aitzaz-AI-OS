import type { JsonObject, JsonValue } from '@nexus/core';

/** Monotonic clock abstraction so every brain component is deterministically testable. */
export interface Clock {
  now(): number;
  timestamp(): string;
}

/** Default clock backed by the host `Date` implementation. */
export class SystemClock implements Clock {
  public now(): number {
    return Date.now();
  }

  public timestamp(): string {
    return new Date().toISOString();
  }
}

/** Deterministic clock used by tests and reproducible simulations. */
export class ManualClock implements Clock {
  public constructor(private current: number = 0) {}

  public now(): number {
    return this.current;
  }

  public timestamp(): string {
    return new Date(this.current).toISOString();
  }

  public advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError('Clock can only advance by a finite, non-negative amount');
    }
    this.current += milliseconds;
  }

  public set(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError('Clock time must be finite and non-negative');
    }
    this.current = milliseconds;
  }
}

/** Identifier of the tenant or user a brain operation is executed on behalf of. */
export interface BrainPrincipal {
  readonly id: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
}

/** Ambient execution context threaded through cognition, agents, and tools. */
export interface BrainContext {
  readonly correlationId: string;
  readonly sessionId?: string;
  readonly conversationId?: string;
  readonly principal?: BrainPrincipal;
  readonly signal: AbortSignal;
  readonly deadline?: number;
  readonly metadata: JsonObject;
}

/** Roles supported by the conversation and prompt subsystems. */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** A single conversational message. */
export interface Message {
  readonly id: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly createdAt: string;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly metadata: JsonObject;
}

/** Confidence expressed on a closed unit interval. */
export type Confidence = number;

/** Numeric embedding vector. */
export type Vector = readonly number[];

/** Similarity metric supported by the vector memory interface. */
export type SimilarityMetric = 'cosine' | 'dot' | 'euclidean';

/** Result of scoring a stored item against a query. */
export interface ScoredResult<T> {
  readonly item: T;
  readonly score: number;
}

/** Structured description of an operation outcome that must never throw. */
export type Outcome<T, E = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** JSON-schema-like descriptor used for tool and agent input validation. */
export interface SchemaDescriptor {
  readonly type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null';
  readonly description?: string;
  readonly properties?: Readonly<Record<string, SchemaDescriptor>>;
  readonly required?: readonly string[];
  readonly items?: SchemaDescriptor;
  readonly enum?: readonly JsonValue[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly additionalProperties?: boolean;
}

/** Convenience alias for records addressed by a stable string key. */
export type Keyed<T> = Readonly<Record<string, T>>;
