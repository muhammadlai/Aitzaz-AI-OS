import { DEFAULT_HEALTH_CHECK_TIMEOUT_MS } from '../constants/index.js';
import { NexusError } from '../errors/index.js';
import type { MaybePromise } from '../types/index.js';
import { withTimeout } from '../utils/index.js';

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';
export interface HealthCheckResult { readonly status: HealthStatus; readonly message?: string; readonly details?: Readonly<Record<string, string | number | boolean>>; }
export interface HealthCheck { readonly name: string; readonly timeoutMs?: number; check(): MaybePromise<HealthCheckResult>; }
export interface HealthReport { readonly status: HealthStatus; readonly checkedAt: string; readonly checks: Readonly<Record<string, HealthCheckResult>>; }

export class HealthMonitor {
  private readonly checks = new Map<string, HealthCheck>();
  public register(check: HealthCheck): void {
    if (check.name.trim() === '') throw new NexusError('INVALID_ARGUMENT', 'Health check name must not be empty');
    if (this.checks.has(check.name)) throw new NexusError('DUPLICATE_REGISTRATION', `Health check "${check.name}" is already registered`);
    this.checks.set(check.name, check);
  }
  public async inspect(): Promise<HealthReport> {
    const checks = Object.fromEntries(await Promise.all([...this.checks.values()].map(async (check) => {
      try { return [check.name, await withTimeout(check.check(), check.timeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS, `Health check ${check.name}`)] as const; }
      catch (error) { return [check.name, { status: 'unhealthy' as const, message: error instanceof Error ? error.message : 'Health check failed' }] as const; }
    })));
    const values = Object.values(checks);
    const status: HealthStatus = values.some((item) => item.status === 'unhealthy') ? 'unhealthy' : values.some((item) => item.status === 'degraded') ? 'degraded' : 'healthy';
    return Object.freeze({ status, checkedAt: new Date().toISOString(), checks: Object.freeze(checks) });
  }
}
