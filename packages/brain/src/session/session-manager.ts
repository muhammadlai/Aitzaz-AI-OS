import { createId, type JsonObject, type JsonValue, type KeyValueStore } from '@nexus/core';
import { invalidArgument, invalidState, notFound } from '../errors/index.js';
import { SystemClock, type BrainPrincipal, type Clock } from '../types/index.js';

/** Lifecycle state of a session. */
export type SessionStatus = 'active' | 'idle' | 'expired' | 'terminated';

/** A stateful interaction scope binding a principal to accumulated state. */
export interface Session {
  readonly id: string;
  readonly status: SessionStatus;
  readonly principal?: BrainPrincipal;
  readonly state: JsonObject;
  readonly conversationIds: readonly string[];
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly expiresAt: string;
  readonly metadata: JsonObject;
}

export interface SessionManagerOptions {
  readonly store: KeyValueStore;
  readonly clock?: Clock;
  /** Inactivity window after which a session expires. */
  readonly ttlMs?: number;
  /** Inactivity window after which an active session is reported idle. */
  readonly idleMs?: number;
  readonly maxStateBytes?: number;
}

/**
 * Manages interaction sessions and their sliding expiry.
 *
 * Every successful access renews the expiry window, so a session stays alive
 * while in use and expires deterministically once abandoned.
 */
export class SessionManager {
  private readonly store: KeyValueStore;
  private readonly clock: Clock;
  private readonly ttlMs: number;
  private readonly idleMs: number;
  private readonly maxStateBytes: number;

  public constructor(options: SessionManagerOptions) {
    this.store = options.store;
    this.clock = options.clock ?? new SystemClock();
    this.ttlMs = options.ttlMs ?? 3_600_000;
    this.idleMs = options.idleMs ?? 300_000;
    this.maxStateBytes = options.maxStateBytes ?? 262_144;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) throw invalidArgument('Session ttlMs must be positive');
    if (this.idleMs > this.ttlMs) throw invalidArgument('idleMs must not exceed ttlMs');
  }

  /** Opens a new session. */
  public async create(
    input: { readonly principal?: BrainPrincipal; readonly state?: JsonObject; readonly metadata?: JsonObject; readonly id?: string } = {}
  ): Promise<Session> {
    const now = this.clock.now();
    const session: Session = {
      id: input.id ?? createId('sess'),
      status: 'active',
      ...(input.principal === undefined ? {} : { principal: input.principal }),
      state: input.state ?? {},
      conversationIds: [],
      createdAt: new Date(now).toISOString(),
      lastActivityAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      metadata: input.metadata ?? {}
    };
    this.assertStateSize(session.state);
    await this.store.set(this.key(session.id), session);
    await this.addToIndex(session.id);
    return session;
  }

  /**
   * Reads a session, applying expiry and idle transitions. Returns `undefined`
   * for unknown or expired sessions.
   */
  public async get(id: string): Promise<Session | undefined> {
    const entry = await this.store.get<Session>(this.key(id));
    if (entry === undefined) return undefined;
    const session = entry.value;
    if (session.status === 'terminated') return session;

    const now = this.clock.now();
    if (now >= Date.parse(session.expiresAt)) {
      const expired: Session = { ...session, status: 'expired' };
      await this.store.set(this.key(id), expired);
      return expired;
    }
    const idle = now - Date.parse(session.lastActivityAt) >= this.idleMs;
    const desired: SessionStatus = idle ? 'idle' : 'active';
    if (session.status !== desired) {
      const adjusted: Session = { ...session, status: desired };
      await this.store.set(this.key(id), adjusted);
      return adjusted;
    }
    return session;
  }

  /** Reads a session, throwing when it is absent, expired, or terminated. */
  public async require(id: string): Promise<Session> {
    const session = await this.get(id);
    if (session === undefined) throw notFound('Session', id);
    if (session.status === 'expired') throw invalidState(`Session "${id}" has expired`, { sessionId: id });
    if (session.status === 'terminated') throw invalidState(`Session "${id}" was terminated`, { sessionId: id });
    return session;
  }

  /** Renews the expiry window and marks the session active. */
  public async touch(id: string): Promise<Session> {
    const session = await this.require(id);
    const now = this.clock.now();
    const renewed: Session = {
      ...session,
      status: 'active',
      lastActivityAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString()
    };
    await this.store.set(this.key(id), renewed);
    return renewed;
  }

  /** Merges values into session state and renews the session. */
  public async setState(id: string, patch: JsonObject): Promise<Session> {
    const session = await this.require(id);
    const state = { ...session.state, ...patch };
    this.assertStateSize(state);
    const now = this.clock.now();
    const updated: Session = {
      ...session,
      status: 'active',
      state,
      lastActivityAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString()
    };
    await this.store.set(this.key(id), updated);
    return updated;
  }

  /** Reads a single value from session state. */
  public async getStateValue(id: string, key: string): Promise<JsonValue | undefined> {
    return (await this.require(id)).state[key];
  }

  /** Associates a conversation with the session. */
  public async attachConversation(id: string, conversationId: string): Promise<Session> {
    const session = await this.require(id);
    if (session.conversationIds.includes(conversationId)) return session;
    const updated: Session = { ...session, conversationIds: [...session.conversationIds, conversationId] };
    await this.store.set(this.key(id), updated);
    return updated;
  }

  /** Ends a session immediately. */
  public async terminate(id: string): Promise<Session> {
    const entry = await this.store.get<Session>(this.key(id));
    if (entry === undefined) throw notFound('Session', id);
    const terminated: Session = { ...entry.value, status: 'terminated' };
    await this.store.set(this.key(id), terminated);
    return terminated;
  }

  /** Deletes expired and terminated sessions, returning how many were removed. */
  public async purge(): Promise<number> {
    const ids = await this.readIndex();
    const surviving: string[] = [];
    let removed = 0;
    for (const id of ids) {
      const session = await this.get(id);
      if (session === undefined || session.status === 'expired' || session.status === 'terminated') {
        await this.store.delete(this.key(id));
        removed += 1;
        continue;
      }
      surviving.push(id);
    }
    await this.store.set(this.indexKey(), surviving);
    return removed;
  }

  /** Lists sessions, optionally filtered by status. */
  public async list(status?: SessionStatus): Promise<readonly Session[]> {
    const ids = await this.readIndex();
    const sessions: Session[] = [];
    for (const id of ids) {
      const session = await this.get(id);
      if (session === undefined) continue;
      if (status === undefined || session.status === status) sessions.push(session);
    }
    return sessions;
  }

  private assertStateSize(state: JsonObject): void {
    const size = JSON.stringify(state).length;
    if (size > this.maxStateBytes) {
      throw invalidArgument(`Session state exceeds the ${this.maxStateBytes} byte limit`, { size });
    }
  }

  private async readIndex(): Promise<readonly string[]> {
    return (await this.store.get<readonly string[]>(this.indexKey()))?.value ?? [];
  }

  private async addToIndex(id: string): Promise<void> {
    const ids = await this.readIndex();
    if (ids.includes(id)) return;
    await this.store.set(this.indexKey(), [...ids, id]);
  }

  private key(id: string): string {
    return `session:${id}`;
  }

  private indexKey(): string {
    return 'session:__index__';
  }
}
