import type { JsonObject } from '../types/index.js';

export type NexusErrorCode =
  | 'AUTHENTICATION_FAILED'
  | 'AUTHORIZATION_DENIED'
  | 'CONFIGURATION_INVALID'
  | 'CONFLICT'
  | 'DEPENDENCY_CYCLE'
  | 'DUPLICATE_REGISTRATION'
  | 'ENCRYPTION_FAILED'
  | 'FEATURE_DISABLED'
  | 'INTERNAL'
  | 'INVALID_ARGUMENT'
  | 'INVALID_STATE'
  | 'NOT_FOUND'
  | 'PLUGIN_LOAD_FAILED'
  | 'SERVICE_UNAVAILABLE'
  | 'TIMEOUT';

const defaultStatus: Readonly<Record<NexusErrorCode, number>> = {
  AUTHENTICATION_FAILED: 401,
  AUTHORIZATION_DENIED: 403,
  CONFIGURATION_INVALID: 500,
  CONFLICT: 409,
  DEPENDENCY_CYCLE: 500,
  DUPLICATE_REGISTRATION: 409,
  ENCRYPTION_FAILED: 500,
  FEATURE_DISABLED: 404,
  INTERNAL: 500,
  INVALID_ARGUMENT: 400,
  INVALID_STATE: 409,
  NOT_FOUND: 404,
  PLUGIN_LOAD_FAILED: 500,
  SERVICE_UNAVAILABLE: 503,
  TIMEOUT: 504
};

export class NexusError extends Error {
  public readonly statusCode: number;
  public readonly metadata: JsonObject;

  public constructor(
    public readonly code: NexusErrorCode,
    message: string,
    options: { readonly cause?: unknown; readonly metadata?: JsonObject; readonly statusCode?: number } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = 'NexusError';
    this.statusCode = options.statusCode ?? defaultStatus[code];
    this.metadata = options.metadata ?? {};
  }
}

export const isNexusError = (value: unknown): value is NexusError => value instanceof NexusError;

export const asNexusError = (value: unknown, fallbackMessage = 'An unexpected system error occurred'): NexusError => {
  if (isNexusError(value)) return value;
  if (value instanceof Error) return new NexusError('INTERNAL', value.message, { cause: value });
  return new NexusError('INTERNAL', fallbackMessage, { metadata: { value: String(value) } });
};
