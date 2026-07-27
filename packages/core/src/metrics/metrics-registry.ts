import { NexusError } from '../errors/index.js';
import { assertSafeIdentifier } from '../utils/index.js';

export type MetricKind = 'counter' | 'gauge' | 'histogram';
export interface MetricSnapshot { readonly name: string; readonly kind: MetricKind; readonly value: number; readonly count?: number; readonly sum?: number; readonly buckets?: Readonly<Record<string, number>>; }

abstract class Metric {
  public constructor(public readonly name: string, public readonly description: string, public readonly kind: MetricKind) {}
  public abstract snapshot(): MetricSnapshot;
}

export class Counter extends Metric {
  private value = 0;
  public constructor(name: string, description: string) { super(name, description, 'counter'); }
  public increment(by = 1): void { if (!Number.isFinite(by) || by < 0) throw new NexusError('INVALID_ARGUMENT', 'Counter increments must be finite and non-negative'); this.value += by; }
  public snapshot(): MetricSnapshot { return Object.freeze({ name: this.name, kind: this.kind, value: this.value }); }
}

export class Gauge extends Metric {
  private value = 0;
  public constructor(name: string, description: string) { super(name, description, 'gauge'); }
  public set(value: number): void { if (!Number.isFinite(value)) throw new NexusError('INVALID_ARGUMENT', 'Gauge value must be finite'); this.value = value; }
  public increment(by = 1): void { this.set(this.value + by); }
  public decrement(by = 1): void { this.set(this.value - by); }
  public snapshot(): MetricSnapshot { return Object.freeze({ name: this.name, kind: this.kind, value: this.value }); }
}

export class Histogram extends Metric {
  private count = 0;
  private sum = 0;
  private readonly bucketCounts: number[];
  public constructor(name: string, description: string, private readonly boundaries: readonly number[]) {
    super(name, description, 'histogram');
    if (boundaries.length === 0 || boundaries.some((item, index) => !Number.isFinite(item) || (index > 0 && item <= (boundaries[index - 1] ?? -Infinity)))) throw new NexusError('INVALID_ARGUMENT', 'Histogram boundaries must be finite and strictly ascending');
    this.bucketCounts = boundaries.map(() => 0);
  }
  public observe(value: number): void {
    if (!Number.isFinite(value)) throw new NexusError('INVALID_ARGUMENT', 'Histogram observation must be finite');
    this.count += 1; this.sum += value;
    for (let index = 0; index < this.boundaries.length; index += 1) if (value <= (this.boundaries[index] as number)) this.bucketCounts[index] = (this.bucketCounts[index] ?? 0) + 1;
  }
  public snapshot(): MetricSnapshot {
    const buckets = Object.fromEntries(this.boundaries.map((boundary, index) => [String(boundary), this.bucketCounts[index] ?? 0]));
    return Object.freeze({ name: this.name, kind: this.kind, value: this.count === 0 ? 0 : this.sum / this.count, count: this.count, sum: this.sum, buckets: Object.freeze(buckets) });
  }
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();
  public counter(name: string, description: string): Counter { return this.register(new Counter(this.validatedName(name), description)); }
  public gauge(name: string, description: string): Gauge { return this.register(new Gauge(this.validatedName(name), description)); }
  public histogram(name: string, description: string, boundaries: readonly number[]): Histogram { return this.register(new Histogram(this.validatedName(name), description, boundaries)); }
  public snapshot(): readonly MetricSnapshot[] { return [...this.metrics.values()].map((metric) => metric.snapshot()); }
  private register<T extends Metric>(metric: T): T { if (this.metrics.has(metric.name)) throw new NexusError('DUPLICATE_REGISTRATION', `Metric "${metric.name}" is already registered`); this.metrics.set(metric.name, metric); return metric; }
  private validatedName(name: string): string { assertSafeIdentifier(name, 'metric name'); return name; }
}
