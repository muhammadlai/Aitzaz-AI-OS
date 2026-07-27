import { NexusError } from '../errors/index.js';
import type { MaybePromise } from '../types/index.js';

export type InjectionToken<T> = string | symbol | (abstract new (...arguments_: never[]) => T);
export type ServiceLifetime = 'singleton' | 'transient';
export interface ResolutionContext { resolve<T>(token: InjectionToken<T>): T; resolveAsync<T>(token: InjectionToken<T>): Promise<T>; }
export type Factory<T> = (container: ResolutionContext) => MaybePromise<T>;

export type ServiceDefinition<T> =
  | { readonly useValue: T }
  | { readonly useFactory: Factory<T>; readonly lifetime?: ServiceLifetime };

interface ServiceEntry<T> {
  readonly factory: Factory<T>;
  readonly lifetime: ServiceLifetime;
  initialized: boolean;
  value?: T;
  pending: Promise<T> | undefined;
}

const tokenName = (token: InjectionToken<unknown>): string => typeof token === 'string' ? token : typeof token === 'symbol' ? token.description ?? token.toString() : token.name;

/** Dependency injection container with cycle detection and deterministic singleton construction. */
export class Container implements ResolutionContext {
  private readonly registrations = new Map<InjectionToken<unknown>, ServiceEntry<unknown>>();
  private readonly resolving: InjectionToken<unknown>[] = [];

  public register<T>(token: InjectionToken<T>, definition: ServiceDefinition<T>): this {
    if (this.registrations.has(token)) throw new NexusError('DUPLICATE_REGISTRATION', `Service "${tokenName(token)}" is already registered`);
    const entry: ServiceEntry<T> = 'useValue' in definition
      ? { factory: () => definition.useValue, lifetime: 'singleton', initialized: true, value: definition.useValue, pending: undefined }
      : { factory: definition.useFactory, lifetime: definition.lifetime ?? 'singleton', initialized: false, pending: undefined };
    this.registrations.set(token, entry as ServiceEntry<unknown>);
    return this;
  }

  public has(token: InjectionToken<unknown>): boolean { return this.registrations.has(token); }

  public resolve<T>(token: InjectionToken<T>): T {
    const entry = this.getEntry(token);
    if (entry.pending !== undefined) throw new NexusError('INVALID_STATE', `Service "${tokenName(token)}" is initializing asynchronously; use resolveAsync`);
    if (entry.initialized && entry.lifetime === 'singleton') return entry.value as T;
    const value = this.invokeFactory(token, entry);
    if (value instanceof Promise) throw new NexusError('INVALID_STATE', `Service "${tokenName(token)}" has an asynchronous factory; use resolveAsync`);
    if (entry.lifetime === 'singleton') { entry.value = value; entry.initialized = true; }
    return value;
  }

  public async resolveAsync<T>(token: InjectionToken<T>): Promise<T> {
    const entry = this.getEntry(token);
    if (entry.initialized && entry.lifetime === 'singleton') return entry.value as T;
    if (entry.pending !== undefined) return entry.pending as Promise<T>;
    const construction = Promise.resolve(this.invokeFactory(token, entry));
    if (entry.lifetime === 'singleton') entry.pending = construction;
    try {
      const value = await construction;
      if (entry.lifetime === 'singleton') { entry.value = value; entry.initialized = true; }
      return value;
    } finally { if (entry.lifetime === 'singleton') entry.pending = undefined; }
  }

  public createChild(): Container { return new Container(this); }

  public constructor(private readonly parent?: Container) {}

  private getEntry<T>(token: InjectionToken<T>): ServiceEntry<T> {
    const own = this.registrations.get(token) as ServiceEntry<T> | undefined;
    if (own !== undefined) return own;
    if (this.parent !== undefined) return this.parent.getEntry(token);
    throw new NexusError('NOT_FOUND', `Service "${tokenName(token)}" is not registered`);
  }

  private invokeFactory<T>(token: InjectionToken<T>, entry: ServiceEntry<T>): MaybePromise<T> {
    if (this.resolving.includes(token)) {
      const path = [...this.resolving, token].map((item) => tokenName(item)).join(' -> ');
      throw new NexusError('DEPENDENCY_CYCLE', `Circular dependency detected: ${path}`);
    }
    this.resolving.push(token);
    try { return entry.factory(this); }
    finally { this.resolving.pop(); }
  }
}
