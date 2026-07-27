import { createId, type JsonObject } from '@nexus/core';
import { timedOut } from '../errors/index.js';
import type { BrainContext } from '../types/index.js';

export interface ContextOptions {
  readonly correlationId?: string;
  readonly sessionId?: string;
  readonly conversationId?: string;
  readonly principal?: BrainContext['principal'];
  readonly signal?: AbortSignal;
  readonly deadline?: number;
  readonly metadata?: JsonObject;
}

const optional = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>);

/** Builds a fully populated brain context, generating identifiers when omitted. */
export const createContext = (options: ContextOptions = {}): BrainContext => ({
  correlationId: options.correlationId ?? createId('ctx'),
  ...optional('sessionId', options.sessionId),
  ...optional('conversationId', options.conversationId),
  ...optional('principal', options.principal),
  signal: options.signal ?? new AbortController().signal,
  ...optional('deadline', options.deadline),
  metadata: options.metadata ?? {}
});

/** Derives a child context, inheriting every unspecified field from the parent. */
export const deriveContext = (parent: BrainContext, overrides: ContextOptions = {}): BrainContext => ({
  correlationId: overrides.correlationId ?? parent.correlationId,
  ...optional('sessionId', overrides.sessionId ?? parent.sessionId),
  ...optional('conversationId', overrides.conversationId ?? parent.conversationId),
  ...optional('principal', overrides.principal ?? parent.principal),
  signal: overrides.signal ?? parent.signal,
  ...optional('deadline', overrides.deadline ?? parent.deadline),
  metadata: { ...parent.metadata, ...(overrides.metadata ?? {}) }
});

/** Throws when the caller aborted the operation or the deadline has elapsed. */
export const assertActive = (context: BrainContext, label: string, now: number = Date.now()): void => {
  if (context.signal.aborted) {
    throw timedOut(`${label} was aborted`, 0);
  }
  if (context.deadline !== undefined && now > context.deadline) {
    throw timedOut(label, Math.max(0, now - context.deadline));
  }
};
