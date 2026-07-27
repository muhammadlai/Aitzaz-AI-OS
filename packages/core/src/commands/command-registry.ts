import { MAX_COMMAND_NAME_LENGTH } from '../constants/index.js';
import { NexusError } from '../errors/index.js';
import type { MaybePromise } from '../types/index.js';
import { assertSafeIdentifier } from '../utils/index.js';

export interface CommandContext { readonly actorId?: string; readonly correlationId: string; readonly signal: AbortSignal; }
export interface CommandDefinition<TInput, TResult> {
  readonly name: string;
  readonly description: string;
  readonly validate?: (input: unknown) => input is TInput;
  readonly execute: (input: TInput, context: CommandContext) => MaybePromise<TResult>;
}

export class CommandRegistry {
  private readonly commands = new Map<string, CommandDefinition<unknown, unknown>>();

  public register<TInput, TResult>(definition: CommandDefinition<TInput, TResult>): void {
    assertSafeIdentifier(definition.name, 'command name');
    if (definition.name.length > MAX_COMMAND_NAME_LENGTH) throw new NexusError('INVALID_ARGUMENT', `Command name must not exceed ${MAX_COMMAND_NAME_LENGTH} characters`);
    if (definition.description.trim().length === 0) throw new NexusError('INVALID_ARGUMENT', 'Command description must not be empty');
    if (this.commands.has(definition.name)) throw new NexusError('DUPLICATE_REGISTRATION', `Command "${definition.name}" is already registered`);
    this.commands.set(definition.name, definition as CommandDefinition<unknown, unknown>);
  }

  public list(): readonly Pick<CommandDefinition<unknown, unknown>, 'name' | 'description'>[] {
    return [...this.commands.values()].map(({ name, description }) => Object.freeze({ name, description }));
  }

  public async execute<TResult>(name: string, input: unknown, context: CommandContext): Promise<TResult> {
    const command = this.commands.get(name);
    if (command === undefined) throw new NexusError('NOT_FOUND', `Command "${name}" is not registered`);
    if (context.signal.aborted) throw new NexusError('INVALID_STATE', `Command "${name}" was aborted`);
    if (command.validate !== undefined && !command.validate(input)) throw new NexusError('INVALID_ARGUMENT', `Input for command "${name}" is invalid`);
    return await command.execute(input, context) as TResult;
  }
}
