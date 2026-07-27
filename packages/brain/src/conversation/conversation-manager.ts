import { createId, type JsonObject, type KeyValueStore } from '@nexus/core';
import { invalidArgument, notFound } from '../errors/index.js';
import { HeuristicTokenEstimator, type TokenEstimator } from '../context/index.js';
import { SystemClock, type Clock, type Message, type MessageRole } from '../types/index.js';

/** A persisted multi-turn conversation. */
export interface Conversation {
  readonly id: string;
  readonly title: string;
  readonly sessionId?: string;
  readonly messages: readonly Message[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata: JsonObject;
}

/** Summary of a conversation segment produced during compaction. */
export interface ConversationSummary {
  readonly conversationId: string;
  readonly summary: string;
  readonly messageCount: number;
  readonly createdAt: string;
}

export interface AppendMessageInput {
  readonly role: MessageRole;
  readonly content: string;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly metadata?: JsonObject;
}

export interface ConversationManagerOptions {
  readonly store: KeyValueStore;
  readonly clock?: Clock;
  readonly estimator?: TokenEstimator;
  /** Message count above which `compact` folds old turns into a summary. */
  readonly compactionThreshold?: number;
  /** Recent messages always preserved verbatim during compaction. */
  readonly retainRecent?: number;
}

/**
 * Durable conversation store with transcript compaction.
 *
 * Long conversations exceed model context windows, so `compact` replaces older
 * turns with a generated summary message while preserving the most recent
 * exchanges verbatim.
 */
export class ConversationManager {
  private readonly store: KeyValueStore;
  private readonly clock: Clock;
  private readonly estimator: TokenEstimator;
  private readonly compactionThreshold: number;
  private readonly retainRecent: number;

  public constructor(options: ConversationManagerOptions) {
    this.store = options.store;
    this.clock = options.clock ?? new SystemClock();
    this.estimator = options.estimator ?? new HeuristicTokenEstimator();
    this.compactionThreshold = options.compactionThreshold ?? 50;
    this.retainRecent = options.retainRecent ?? 10;
    if (this.retainRecent >= this.compactionThreshold) {
      throw invalidArgument('retainRecent must be smaller than compactionThreshold');
    }
  }

  /** Creates an empty conversation. */
  public async create(
    input: { readonly title?: string; readonly sessionId?: string; readonly metadata?: JsonObject; readonly id?: string } = {}
  ): Promise<Conversation> {
    const now = this.clock.timestamp();
    const conversation: Conversation = {
      id: input.id ?? createId('conv'),
      title: input.title ?? 'Untitled conversation',
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      messages: [],
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata ?? {}
    };
    await this.store.set(this.key(conversation.id), conversation);
    await this.addToIndex(conversation.id);
    return conversation;
  }

  public async get(id: string): Promise<Conversation | undefined> {
    return (await this.store.get<Conversation>(this.key(id)))?.value;
  }

  public async require(id: string): Promise<Conversation> {
    const conversation = await this.get(id);
    if (conversation === undefined) throw notFound('Conversation', id);
    return conversation;
  }

  /** Appends a message and returns the updated conversation. */
  public async append(conversationId: string, input: AppendMessageInput): Promise<Conversation> {
    if (input.content.trim() === '' && input.role !== 'tool') {
      throw invalidArgument('Message content must not be empty');
    }
    const conversation = await this.require(conversationId);
    const message: Message = {
      id: createId('msg'),
      role: input.role,
      content: input.content,
      createdAt: this.clock.timestamp(),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      metadata: input.metadata ?? {}
    };
    const updated: Conversation = {
      ...conversation,
      messages: [...conversation.messages, message],
      updatedAt: message.createdAt
    };
    await this.store.set(this.key(conversationId), updated);
    return updated;
  }

  /** Appends several messages atomically. */
  public async appendMany(conversationId: string, inputs: readonly AppendMessageInput[]): Promise<Conversation> {
    let conversation = await this.require(conversationId);
    for (const input of inputs) conversation = await this.append(conversation.id, input);
    return conversation;
  }

  /** The most recent `count` messages, oldest first. */
  public async history(conversationId: string, count?: number): Promise<readonly Message[]> {
    const conversation = await this.require(conversationId);
    return count === undefined ? conversation.messages : conversation.messages.slice(-count);
  }

  /** Messages that fit within a token budget, preferring the most recent. */
  public async window(conversationId: string, tokenBudget: number): Promise<readonly Message[]> {
    if (!Number.isInteger(tokenBudget) || tokenBudget < 1) {
      throw invalidArgument('tokenBudget must be a positive integer');
    }
    const conversation = await this.require(conversationId);
    const selected: Message[] = [];
    let used = 0;
    for (const message of [...conversation.messages].reverse()) {
      const cost = this.estimator.estimate(`${message.role}: ${message.content}`);
      if (used + cost > tokenBudget) break;
      selected.unshift(message);
      used += cost;
    }
    return selected;
  }

  /** Estimated token cost of the full transcript. */
  public async tokenCount(conversationId: string): Promise<number> {
    const conversation = await this.require(conversationId);
    return conversation.messages.reduce(
      (total, message) => total + this.estimator.estimate(`${message.role}: ${message.content}`),
      0
    );
  }

  /**
   * Folds older messages into a single summary message when the transcript
   * exceeds the configured threshold. Returns `undefined` when no compaction
   * was necessary.
   */
  public async compact(
    conversationId: string,
    summarize?: (messages: readonly Message[]) => Promise<string>
  ): Promise<ConversationSummary | undefined> {
    const conversation = await this.require(conversationId);
    if (conversation.messages.length <= this.compactionThreshold) return undefined;

    const cutoff = conversation.messages.length - this.retainRecent;
    const older = conversation.messages.slice(0, cutoff);
    const recent = conversation.messages.slice(cutoff);
    const summaryText = summarize === undefined ? this.defaultSummary(older) : await summarize(older);

    const summaryMessage: Message = {
      id: createId('msg'),
      role: 'system',
      content: `Conversation summary of ${older.length} earlier messages: ${summaryText}`,
      createdAt: this.clock.timestamp(),
      metadata: { compacted: true, summarizedCount: older.length }
    };

    const updated: Conversation = {
      ...conversation,
      messages: [summaryMessage, ...recent],
      updatedAt: summaryMessage.createdAt
    };
    await this.store.set(this.key(conversationId), updated);

    return {
      conversationId,
      summary: summaryText,
      messageCount: older.length,
      createdAt: summaryMessage.createdAt
    };
  }

  /** Removes a conversation permanently. */
  public async delete(id: string): Promise<boolean> {
    const removed = await this.store.delete(this.key(id));
    const index = await this.readIndex();
    await this.store.set(this.indexKey(), index.filter((entry) => entry !== id));
    return removed;
  }

  /** Lists all known conversations, newest first. */
  public async list(): Promise<readonly Conversation[]> {
    const ids = await this.readIndex();
    const conversations: Conversation[] = [];
    for (const id of ids) {
      const conversation = await this.get(id);
      if (conversation !== undefined) conversations.push(conversation);
    }
    return conversations.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private defaultSummary(messages: readonly Message[]): string {
    const byRole = new Map<MessageRole, number>();
    for (const message of messages) byRole.set(message.role, (byRole.get(message.role) ?? 0) + 1);
    const distribution = [...byRole.entries()].map(([role, count]) => `${count} ${role}`).join(', ');
    const firstUser = messages.find((message) => message.role === 'user')?.content ?? '';
    const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')?.content ?? '';
    const opening = firstUser === '' ? '' : ` It opened with: "${this.truncate(firstUser, 160)}".`;
    const closing = lastAssistant === '' ? '' : ` The last assistant reply was: "${this.truncate(lastAssistant, 160)}".`;
    return `${distribution} messages exchanged.${opening}${closing}`;
  }

  private truncate(text: string, limit: number): string {
    return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
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
    return `conversation:${id}`;
  }

  private indexKey(): string {
    return 'conversation:__index__';
  }
}
