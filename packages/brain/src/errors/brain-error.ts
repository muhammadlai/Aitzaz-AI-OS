import { NexusError, type JsonObject } from '@nexus/core';

/**
 * Brain-layer failures reuse the Phase 1 `NexusError` contract so HTTP status
 * mapping, logging, and error serialization stay consistent across the OS.
 */
export class BrainError extends NexusError {
  public constructor(
    code: ConstructorParameters<typeof NexusError>[0],
    message: string,
    options: { readonly cause?: unknown; readonly metadata?: JsonObject; readonly statusCode?: number } = {}
  ) {
    super(code, message, options);
    this.name = 'BrainError';
  }
}

export const notFound = (what: string, id: string): BrainError =>
  new BrainError('NOT_FOUND', `${what} "${id}" was not found`, { metadata: { id } });

export const invalidArgument = (message: string, metadata: JsonObject = {}): BrainError =>
  new BrainError('INVALID_ARGUMENT', message, { metadata });

export const invalidState = (message: string, metadata: JsonObject = {}): BrainError =>
  new BrainError('INVALID_STATE', message, { metadata });

export const duplicate = (what: string, id: string): BrainError =>
  new BrainError('DUPLICATE_REGISTRATION', `${what} "${id}" is already registered`, { metadata: { id } });

export const timedOut = (what: string, timeoutMs: number): BrainError =>
  new BrainError('TIMEOUT', `${what} timed out after ${timeoutMs}ms`, { metadata: { timeoutMs } });
