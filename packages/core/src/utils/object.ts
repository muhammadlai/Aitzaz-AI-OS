import type { JsonObject, JsonValue } from '../types/index.js';

export const deepFreeze = <T>(value: T): Readonly<T> => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value as Readonly<T>;
};

export const deepClone = <T>(value: T): T => structuredClone(value);

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export const mergeJsonObjects = (base: JsonObject, patch: JsonObject): JsonObject => {
  const result: Record<string, JsonValue> = { ...base };
  for (const [key, patchValue] of Object.entries(patch)) {
    const baseValue = result[key];
    result[key] = isPlainObject(baseValue) && isPlainObject(patchValue)
      ? mergeJsonObjects(baseValue as JsonObject, patchValue as JsonObject)
      : patchValue;
  }
  return result;
};
