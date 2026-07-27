import type { JsonObject, JsonValue } from '@nexus/core';
import { duplicate, invalidArgument, notFound } from '../errors/index.js';
import { SystemClock, type Clock, type MessageRole } from '../types/index.js';

/** A declared variable a template expects at render time. */
export interface PromptVariable {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly defaultValue?: string;
}

/** A versioned, reusable prompt definition. */
export interface PromptTemplate {
  readonly id: string;
  readonly version: number;
  readonly role: MessageRole;
  readonly template: string;
  readonly description: string;
  readonly variables: readonly PromptVariable[];
  readonly tags: readonly string[];
  readonly createdAt: string;
  readonly metadata: JsonObject;
}

/** The result of rendering a template. */
export interface RenderedPrompt {
  readonly templateId: string;
  readonly version: number;
  readonly role: MessageRole;
  readonly text: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly renderedAt: string;
}

export interface PromptTemplateInput {
  readonly id: string;
  readonly template: string;
  readonly description?: string;
  readonly role?: MessageRole;
  readonly variables?: readonly PromptVariable[];
  readonly tags?: readonly string[];
  readonly metadata?: JsonObject;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g;

/**
 * Registry of versioned prompt templates.
 *
 * Registering the same id again creates a new version rather than overwriting,
 * so prompts remain auditable and previous versions stay renderable.
 * Placeholders use `{{ name }}` syntax and are validated at registration time
 * against the declared variables.
 */
export class PromptManager {
  private readonly templates = new Map<string, PromptTemplate[]>();
  private readonly clock: Clock;

  public constructor(clock: Clock = new SystemClock()) {
    this.clock = clock;
  }

  /** Registers the first version of a template. */
  public register(input: PromptTemplateInput): PromptTemplate {
    if (this.templates.has(input.id)) throw duplicate('Prompt template', input.id);
    return this.write(input, 1);
  }

  /** Adds a new version of an existing template. */
  public addVersion(input: PromptTemplateInput): PromptTemplate {
    const versions = this.templates.get(input.id);
    if (versions === undefined) throw notFound('Prompt template', input.id);
    return this.write(input, (versions.at(-1) as PromptTemplate).version + 1);
  }

  /** Registers a template or adds a version when it already exists. */
  public upsert(input: PromptTemplateInput): PromptTemplate {
    return this.templates.has(input.id) ? this.addVersion(input) : this.register(input);
  }

  /** Retrieves a template, defaulting to the latest version. */
  public get(id: string, version?: number): PromptTemplate {
    const versions = this.templates.get(id);
    if (versions === undefined || versions.length === 0) throw notFound('Prompt template', id);
    if (version === undefined) return versions.at(-1) as PromptTemplate;
    const found = versions.find((entry) => entry.version === version);
    if (found === undefined) throw notFound(`Prompt template "${id}" version`, String(version));
    return found;
  }

  public has(id: string): boolean {
    return this.templates.has(id);
  }

  public list(tag?: string): readonly PromptTemplate[] {
    const latest = [...this.templates.values()].flatMap((versions) => {
      const newest = versions.at(-1);
      return newest === undefined ? [] : [newest];
    });
    return tag === undefined ? latest : latest.filter((template) => template.tags.includes(tag));
  }

  public versions(id: string): readonly PromptTemplate[] {
    const versions = this.templates.get(id);
    if (versions === undefined) throw notFound('Prompt template', id);
    return [...versions];
  }

  public remove(id: string): boolean {
    return this.templates.delete(id);
  }

  /**
   * Renders a template. Missing required variables raise an error; declared
   * defaults are substituted for optional ones.
   */
  public render(id: string, values: Readonly<Record<string, JsonValue>> = {}, version?: number): RenderedPrompt {
    const template = this.get(id, version);
    const resolved: Record<string, string> = {};

    for (const variable of template.variables) {
      const provided = values[variable.name];
      if (provided === undefined || provided === null) {
        if (variable.required && variable.defaultValue === undefined) {
          throw invalidArgument(`Prompt "${id}" requires variable "${variable.name}"`);
        }
        if (variable.defaultValue !== undefined) resolved[variable.name] = variable.defaultValue;
        continue;
      }
      resolved[variable.name] = typeof provided === 'string' ? provided : JSON.stringify(provided);
    }

    // Undeclared values are still substitutable, which keeps ad-hoc prompts practical.
    for (const [key, value] of Object.entries(values)) {
      if (resolved[key] === undefined && value !== null && value !== undefined) {
        resolved[key] = typeof value === 'string' ? value : JSON.stringify(value);
      }
    }

    const text = template.template.replace(PLACEHOLDER, (match, name: string) => {
      const replacement = resolved[name];
      if (replacement === undefined) {
        throw invalidArgument(`Prompt "${id}" has no value for placeholder "${name}"`);
      }
      return replacement;
    });

    return {
      templateId: template.id,
      version: template.version,
      role: template.role,
      text,
      variables: Object.freeze({ ...resolved }),
      renderedAt: this.clock.timestamp()
    };
  }

  /** Lists placeholder names appearing in a template body. */
  public static extractPlaceholders(template: string): readonly string[] {
    const found = new Set<string>();
    for (const match of template.matchAll(PLACEHOLDER)) {
      const name = match[1];
      if (name !== undefined) found.add(name);
    }
    return [...found];
  }

  private write(input: PromptTemplateInput, version: number): PromptTemplate {
    if (input.id.trim() === '') throw invalidArgument('Prompt template id must not be empty');
    if (input.template.trim() === '') throw invalidArgument('Prompt template body must not be empty');

    const variables = input.variables ?? [];
    const declared = new Set(variables.map((variable) => variable.name));
    for (const placeholder of PromptManager.extractPlaceholders(input.template)) {
      if (variables.length > 0 && !declared.has(placeholder)) {
        throw invalidArgument(`Prompt "${input.id}" uses undeclared placeholder "${placeholder}"`);
      }
    }

    const template: PromptTemplate = {
      id: input.id,
      version,
      role: input.role ?? 'system',
      template: input.template,
      description: input.description ?? input.id,
      variables: Object.freeze([...variables]),
      tags: Object.freeze([...new Set(input.tags ?? [])]),
      createdAt: this.clock.timestamp(),
      metadata: input.metadata ?? {}
    };

    const existing = this.templates.get(input.id) ?? [];
    existing.push(template);
    this.templates.set(input.id, existing);
    return template;
  }
}
