import { createId, type JsonObject, type JsonValue } from '@nexus/core';
import { duplicate, invalidArgument, notFound, timedOut } from '../errors/index.js';
import { SystemClock, type BrainContext, type Clock, type SchemaDescriptor } from '../types/index.js';
import { assertSchema, validateSchema } from '../utils/index.js';

/** Execution context handed to a tool implementation. */
export interface ToolContext {
  readonly callId: string;
  readonly brain: BrainContext;
  readonly signal: AbortSignal;
  readonly logger: (message: string, data?: JsonObject) => void;
}

/** A callable capability exposed to agents and reasoning steps. */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: SchemaDescriptor;
  readonly outputSchema?: SchemaDescriptor;
  /** Permissions a principal must hold to invoke this tool. */
  readonly requiredPermissions?: readonly string[];
  readonly timeoutMs?: number;
  /** Tools flagged idempotent may be retried safely. */
  readonly idempotent?: boolean;
  readonly tags?: readonly string[];
  execute(input: JsonValue, context: ToolContext): Promise<JsonValue>;
}

/** A request to invoke a tool. */
export interface ToolCall {
  readonly id: string;
  readonly tool: string;
  readonly input: JsonValue;
}

/** The outcome of a tool invocation. */
export interface ToolResult {
  readonly callId: string;
  readonly tool: string;
  readonly success: boolean;
  readonly output?: JsonValue;
  readonly error?: string;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly logs: readonly string[];
}

/** Machine-readable tool description for model function-calling APIs. */
export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly parameters: SchemaDescriptor;
}

export interface ToolRegistryOptions {
  readonly clock?: Clock;
  readonly defaultTimeoutMs?: number;
  readonly maxRetries?: number;
  /** Resolves the permissions held by the caller of a context. */
  readonly permissionResolver?: (context: BrainContext) => readonly string[];
}

/**
 * Registry and execution surface for tools.
 *
 * Inputs are validated against each tool's schema before execution, execution
 * is bounded by a timeout, permissions are enforced, and idempotent tools are
 * retried with exponential backoff.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly clock: Clock;
  private readonly defaultTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly permissionResolver: ((context: BrainContext) => readonly string[]) | undefined;

  public constructor(options: ToolRegistryOptions = {}) {
    this.clock = options.clock ?? new SystemClock();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.permissionResolver = options.permissionResolver;
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0) {
      throw invalidArgument('maxRetries must be a non-negative integer');
    }
  }

  /** Registers a tool, rejecting duplicate names. */
  public register(tool: Tool): void {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(tool.name)) {
      throw invalidArgument(`Invalid tool name "${tool.name}"`);
    }
    if (tool.description.trim() === '') throw invalidArgument(`Tool "${tool.name}" requires a description`);
    if (this.tools.has(tool.name)) throw duplicate('Tool', tool.name);
    this.tools.set(tool.name, tool);
  }

  public unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  public has(name: string): boolean {
    return this.tools.has(name);
  }

  public get(name: string): Tool {
    const tool = this.tools.get(name);
    if (tool === undefined) throw notFound('Tool', name);
    return tool;
  }

  public list(tag?: string): readonly Tool[] {
    const all = [...this.tools.values()];
    return tag === undefined ? all : all.filter((tool) => (tool.tags ?? []).includes(tag));
  }

  /** Function-calling descriptors suitable for a model request payload. */
  public describe(tag?: string): readonly ToolDescriptor[] {
    return this.list(tag).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }));
  }

  /** Validates a call's input without executing the tool. */
  public validate(call: Pick<ToolCall, 'tool' | 'input'>): readonly string[] {
    const tool = this.get(call.tool);
    const result = validateSchema(call.input, tool.inputSchema);
    return result.ok ? [] : result.error;
  }

  /** Executes a tool with validation, permission checks, timeout, and retries. */
  public async invoke(call: ToolCall, context: BrainContext): Promise<ToolResult> {
    const tool = this.get(call.tool);
    const startedAt = this.clock.timestamp();
    const startedTime = this.clock.now();
    const logs: string[] = [];

    const fail = (message: string): ToolResult => ({
      callId: call.id,
      tool: call.tool,
      success: false,
      error: message,
      durationMs: this.clock.now() - startedTime,
      startedAt,
      logs
    });

    if (this.permissionResolver !== undefined && (tool.requiredPermissions ?? []).length > 0) {
      const held = new Set(this.permissionResolver(context));
      const missing = (tool.requiredPermissions ?? []).filter((permission) => !held.has(permission));
      if (missing.length > 0) return fail(`Missing required permission(s): ${missing.join(', ')}`);
    }

    const validation = validateSchema(call.input, tool.inputSchema);
    if (!validation.ok) return fail(`Input validation failed: ${validation.error.join('; ')}`);

    const attempts = tool.idempotent === true ? this.maxRetries + 1 : 1;
    let lastError = 'Tool execution failed';

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (context.signal.aborted) return fail('Tool execution aborted by caller');
      try {
        const output = await this.runOnce(tool, call, context, logs);
        if (tool.outputSchema !== undefined) {
          assertSchema(output, tool.outputSchema, `Tool "${tool.name}" output`);
        }
        return {
          callId: call.id,
          tool: call.tool,
          success: true,
          output,
          durationMs: this.clock.now() - startedTime,
          startedAt,
          logs
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        logs.push(`attempt ${attempt + 1} failed: ${lastError}`);
        if (attempt < attempts - 1) {
          await this.delay(2 ** attempt * 50);
        }
      }
    }
    return fail(lastError);
  }

  /** Executes several calls concurrently, preserving input order in the results. */
  public async invokeAll(calls: readonly ToolCall[], context: BrainContext): Promise<readonly ToolResult[]> {
    return Promise.all(calls.map((call) => this.invoke(call, context)));
  }

  /** Creates a well-formed call with a generated id. */
  public static call(tool: string, input: JsonValue): ToolCall {
    return { id: createId('call'), tool, input };
  }

  private async runOnce(tool: Tool, call: ToolCall, context: BrainContext, logs: string[]): Promise<JsonValue> {
    const timeoutMs = tool.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const abortListener = (): void => controller.abort();
    context.signal.addEventListener('abort', abortListener, { once: true });

    const toolContext: ToolContext = {
      callId: call.id,
      brain: context,
      signal: controller.signal,
      logger: (message, data) => logs.push(data === undefined ? message : `${message} ${JSON.stringify(data)}`)
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        tool.execute(call.input, toolContext),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(timedOut(`Tool "${tool.name}"`, timeoutMs));
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      context.signal.removeEventListener('abort', abortListener);
    }
  }

  private async delay(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }
}
