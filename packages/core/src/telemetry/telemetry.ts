import type { JsonValue } from '../types/index.js';
import { createId } from '../utils/index.js';

export type SpanStatus = 'ok' | 'error';
export interface SpanRecord {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly status: SpanStatus;
  readonly attributes: Readonly<Record<string, JsonValue>>;
  readonly error?: { readonly name: string; readonly message: string };
}
export interface SpanExporter { export(span: SpanRecord): void | Promise<void>; }
export interface ActiveSpan {
  readonly traceId: string;
  readonly spanId: string;
  setAttribute(name: string, value: JsonValue): void;
  end(error?: unknown): void;
}

export class Telemetry {
  public constructor(private readonly exporter: SpanExporter, private readonly enabled = true) {}
  public startSpan(name: string, attributes: Readonly<Record<string, JsonValue>> = {}, parent?: Pick<ActiveSpan, 'traceId' | 'spanId'>): ActiveSpan {
    const traceId = parent?.traceId ?? createId('trace');
    const spanId = createId('span');
    const startedAt = new Date();
    const values: Record<string, JsonValue> = { ...attributes };
    let ended = false;
    return {
      traceId,
      spanId,
      setAttribute: (key, value) => { if (!ended) values[key] = value; },
      end: (error) => {
        if (ended) return;
        ended = true;
        if (!this.enabled) return;
        const errorValue = error instanceof Error ? { name: error.name, message: error.message } : undefined;
        const record: SpanRecord = {
          traceId, spanId, ...(parent === undefined ? {} : { parentSpanId: parent.spanId }), name,
          startedAt: startedAt.toISOString(), endedAt: new Date().toISOString(), durationMs: Date.now() - startedAt.getTime(),
          status: errorValue === undefined ? 'ok' : 'error', attributes: Object.freeze({ ...values }), ...(errorValue === undefined ? {} : { error: errorValue })
        };
        void Promise.resolve(this.exporter.export(record)).catch(() => undefined);
      }
    };
  }

  public async withSpan<T>(name: string, operation: (span: ActiveSpan) => Promise<T>, attributes: Readonly<Record<string, JsonValue>> = {}): Promise<T> {
    const span = this.startSpan(name, attributes);
    try { const result = await operation(span); span.end(); return result; }
    catch (error) { span.end(error); throw error; }
  }
}

export class InMemorySpanExporter implements SpanExporter {
  private readonly spans: SpanRecord[] = [];
  public constructor(private readonly capacity = 1_000) {}
  public export(span: SpanRecord): void { this.spans.push(span); if (this.spans.length > this.capacity) this.spans.splice(0, this.spans.length - this.capacity); }
  public list(): readonly SpanRecord[] { return [...this.spans]; }
}
