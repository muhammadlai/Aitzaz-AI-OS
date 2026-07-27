import type { JsonValue } from '@nexus/core';
import { invalidArgument } from '../errors/index.js';
import type { Outcome, SchemaDescriptor } from '../types/index.js';

const typeOf = (value: JsonValue): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

const matchesType = (value: JsonValue, expected: SchemaDescriptor['type']): boolean => {
  const actual = typeOf(value);
  if (expected === 'integer') return actual === 'number' && Number.isInteger(value);
  if (expected === 'number') return actual === 'number' && Number.isFinite(value as number);
  return actual === expected;
};

const validateNode = (value: JsonValue, schema: SchemaDescriptor, path: string, errors: string[]): void => {
  if (!matchesType(value, schema.type)) {
    errors.push(`${path} must be of type ${schema.type} but received ${typeOf(value)}`);
    return;
  }

  if (schema.enum !== undefined && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    errors.push(`${path} must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`);
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path} must have at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path} must have at most ${schema.maxLength} characters`);
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((entry, index) => validateNode(entry, schema.items as SchemaDescriptor, `${path}[${index}]`, errors));
  }

  if (schema.type === 'object' && typeOf(value) === 'object') {
    const record = value as Readonly<Record<string, JsonValue>>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) errors.push(`${path}.${key} is required`);
    }
    const properties = schema.properties ?? {};
    for (const [key, entry] of Object.entries(record)) {
      const propertySchema = properties[key];
      if (propertySchema === undefined) {
        if (schema.additionalProperties === false) errors.push(`${path}.${key} is not an allowed property`);
        continue;
      }
      validateNode(entry, propertySchema, `${path}.${key}`, errors);
    }
  }
};

/** Validates a JSON value against a schema descriptor, returning every violation found. */
export const validateSchema = (value: JsonValue, schema: SchemaDescriptor): Outcome<JsonValue, readonly string[]> => {
  const errors: string[] = [];
  validateNode(value, schema, '$', errors);
  return errors.length === 0 ? { ok: true, value } : { ok: false, error: errors };
};

/** Validates a value and throws a `BrainError` describing all violations. */
export const assertSchema = (value: JsonValue, schema: SchemaDescriptor, label: string): JsonValue => {
  const result = validateSchema(value, schema);
  if (!result.ok) {
    throw invalidArgument(`${label} failed schema validation: ${result.error.join('; ')}`, {
      violations: result.error as unknown as JsonValue
    });
  }
  return result.value;
};
