import type { JsonObject } from '@nexus/core';
import type { Vector } from '../types/index.js';

/** Cognitive category of a stored memory, mirroring human memory systems. */
export type MemoryKind = 'episodic' | 'semantic' | 'procedural' | 'working';

/** A durable memory record owned by a namespace. */
export interface MemoryRecord {
  readonly id: string;
  readonly namespace: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly importance: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastAccessedAt: string;
  readonly accessCount: number;
  readonly expiresAt?: string;
  readonly tags: readonly string[];
  readonly embedding?: Vector;
  readonly metadata: JsonObject;
}

/** Input accepted when writing a new memory. */
export interface MemoryInput {
  readonly namespace: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly importance?: number;
  readonly tags?: readonly string[];
  readonly ttlMs?: number;
  readonly embedding?: Vector;
  readonly metadata?: JsonObject;
  readonly id?: string;
}

/** Filter applied when querying memories. */
export interface MemoryQuery {
  readonly namespace: string;
  readonly kinds?: readonly MemoryKind[];
  readonly tags?: readonly string[];
  readonly text?: string;
  readonly minImportance?: number;
  readonly limit?: number;
  readonly includeExpired?: boolean;
}

/** Statistics describing the contents of a namespace. */
export interface MemoryStatistics {
  readonly namespace: string;
  readonly total: number;
  readonly byKind: Readonly<Record<MemoryKind, number>>;
  readonly averageImportance: number;
  readonly oldestCreatedAt?: string;
  readonly newestCreatedAt?: string;
}
