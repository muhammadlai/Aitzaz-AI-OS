import { NexusError } from '../errors/index.js';
import type { Subscription } from '../types/index.js';
import { assertSafeIdentifier } from '../utils/index.js';

export interface RegisteredService<T = unknown> {
  readonly id: string;
  readonly instance: T;
  readonly tags: readonly string[];
  readonly registeredAt: Date;
}
export type ServiceRegistryListener = (event: 'registered' | 'unregistered', service: RegisteredService) => void | Promise<void>;

export class ServiceRegistry {
  private readonly services = new Map<string, RegisteredService>();
  private readonly listeners = new Set<ServiceRegistryListener>();

  public register<T>(id: string, instance: T, tags: readonly string[] = []): RegisteredService<T> {
    assertSafeIdentifier(id, 'service id');
    if (this.services.has(id)) throw new NexusError('DUPLICATE_REGISTRATION', `Service "${id}" is already registered`);
    const service: RegisteredService<T> = Object.freeze({ id, instance, tags: Object.freeze([...new Set(tags)]), registeredAt: new Date() });
    this.services.set(id, service as RegisteredService);
    this.notify('registered', service);
    return service;
  }

  public get<T>(id: string): T {
    const service = this.services.get(id);
    if (service === undefined) throw new NexusError('NOT_FOUND', `Service "${id}" is not registered`);
    return service.instance as T;
  }

  public find<T>(id: string): T | undefined { return this.services.get(id)?.instance as T | undefined; }
  public list(tag?: string): readonly RegisteredService[] { return [...this.services.values()].filter((service) => tag === undefined || service.tags.includes(tag)); }

  public unregister(id: string): void {
    const service = this.services.get(id);
    if (service === undefined) return;
    this.services.delete(id);
    this.notify('unregistered', service);
  }

  public subscribe(listener: ServiceRegistryListener): Subscription {
    this.listeners.add(listener);
    let closed = false;
    return { get closed(): boolean { return closed; }, dispose: () => { closed = true; this.listeners.delete(listener); } };
  }

  private notify(event: 'registered' | 'unregistered', service: RegisteredService): void {
    for (const listener of this.listeners) void Promise.resolve(listener(event, service)).catch(() => undefined);
  }
}
