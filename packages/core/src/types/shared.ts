/** Shared contracts used throughout the Nexus AI OS runtime. */
export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { readonly [key: string]: JsonValue; }

export type EnvironmentName = 'development' | 'test' | 'staging' | 'production';
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type RuntimeState = 'created' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';
export type LifecyclePhase = 'bootstrap' | 'initialize' | 'ready' | 'shutdown';

export interface NexusConfiguration {
  readonly environment: EnvironmentName;
  readonly applicationName: string;
  readonly logLevel: LogLevel;
  readonly featureFlags: Readonly<Record<string, boolean>>;
  readonly api: {
    readonly host: string;
    readonly port: number;
    readonly corsOrigins: readonly string[];
  };
  readonly auth: {
    readonly issuer?: string;
    readonly audience?: string;
  };
  readonly telemetry: {
    readonly enabled: boolean;
    readonly serviceName: string;
  };
}

export interface Disposable { dispose(): void | Promise<void>; }
export interface AsyncDisposable { dispose(): Promise<void>; }
export interface Subscription extends Disposable { readonly closed: boolean; }
export type MaybePromise<T> = T | Promise<T>;
export type Constructor<T> = abstract new (...args: never[]) => T;

export interface PaginationCursor {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}
