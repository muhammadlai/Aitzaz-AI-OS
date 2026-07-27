import type { JsonValue, LogLevel } from '../types/index.js';

export interface LogRecord {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly context: Readonly<Record<string, JsonValue>>;
  readonly error?: { readonly name: string; readonly message: string; readonly stack?: string };
}

export interface LogSink { write(record: LogRecord): void | Promise<void>; }
export interface Logger {
  trace(message: string, context?: Readonly<Record<string, JsonValue>>): void;
  debug(message: string, context?: Readonly<Record<string, JsonValue>>): void;
  info(message: string, context?: Readonly<Record<string, JsonValue>>): void;
  warn(message: string, context?: Readonly<Record<string, JsonValue>>): void;
  error(message: string, error?: unknown, context?: Readonly<Record<string, JsonValue>>): void;
  fatal(message: string, error?: unknown, context?: Readonly<Record<string, JsonValue>>): void;
  child(context: Readonly<Record<string, JsonValue>>): Logger;
}

const priorities: Readonly<Record<LogLevel, number>> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };

export class ConsoleLogSink implements LogSink {
  public write(record: LogRecord): void {
    const output = JSON.stringify(record);
    if (record.level === 'error' || record.level === 'fatal') console.error(output);
    else if (record.level === 'warn') console.warn(output);
    else console.log(output);
  }
}

export class StructuredLogger implements Logger {
  public constructor(
    private readonly minimumLevel: LogLevel,
    private readonly sinks: readonly LogSink[] = [new ConsoleLogSink()],
    private readonly baseContext: Readonly<Record<string, JsonValue>> = {}
  ) {}

  public trace(message: string, context: Readonly<Record<string, JsonValue>> = {}): void { this.log('trace', message, undefined, context); }
  public debug(message: string, context: Readonly<Record<string, JsonValue>> = {}): void { this.log('debug', message, undefined, context); }
  public info(message: string, context: Readonly<Record<string, JsonValue>> = {}): void { this.log('info', message, undefined, context); }
  public warn(message: string, context: Readonly<Record<string, JsonValue>> = {}): void { this.log('warn', message, undefined, context); }
  public error(message: string, error?: unknown, context: Readonly<Record<string, JsonValue>> = {}): void { this.log('error', message, error, context); }
  public fatal(message: string, error?: unknown, context: Readonly<Record<string, JsonValue>> = {}): void { this.log('fatal', message, error, context); }
  public child(context: Readonly<Record<string, JsonValue>>): Logger { return new StructuredLogger(this.minimumLevel, this.sinks, { ...this.baseContext, ...context }); }

  private log(level: LogLevel, message: string, error: unknown, context: Readonly<Record<string, JsonValue>>): void {
    if (priorities[level] < priorities[this.minimumLevel]) return;
    const errorDetail = error instanceof Error ? { name: error.name, message: error.message, ...(error.stack === undefined ? {} : { stack: error.stack }) } : undefined;
    const record: LogRecord = { timestamp: new Date().toISOString(), level, message, context: { ...this.baseContext, ...context }, ...(errorDetail === undefined ? {} : { error: errorDetail }) };
    for (const sink of this.sinks) void Promise.resolve(sink.write(record)).catch(() => undefined);
  }
}

export class InMemoryLogSink implements LogSink {
  private readonly records: LogRecord[] = [];
  public constructor(private readonly capacity = 500) {}
  public write(record: LogRecord): void { this.records.push(record); if (this.records.length > this.capacity) this.records.splice(0, this.records.length - this.capacity); }
  public list(): readonly LogRecord[] { return [...this.records]; }
}
