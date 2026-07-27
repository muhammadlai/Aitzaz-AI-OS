import { NexusError } from '../errors/index.js';

export const assertNonEmptyString = (value: string, name: string): string => {
  if (value.trim().length === 0) throw new NexusError('INVALID_ARGUMENT', `${name} must not be empty`);
  return value;
};

export const assertSafeIdentifier = (value: string, name: string): string => {
  assertNonEmptyString(value, name);
  if (!/^[a-zA-Z][a-zA-Z0-9._:-]*$/.test(value)) throw new NexusError('INVALID_ARGUMENT', `${name} contains unsupported characters`);
  return value;
};

export const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new NexusError('CONFIGURATION_INVALID', `Expected a boolean value, received "${value}"`);
};

export const parseInteger = (value: string | undefined, fallback: number, name: string, range: readonly [number, number]): number => {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < range[0] || parsed > range[1]) {
    throw new NexusError('CONFIGURATION_INVALID', `${name} must be an integer between ${range[0]} and ${range[1]}`);
  }
  return parsed;
};

export const parseCommaList = (value: string | undefined): readonly string[] =>
  value === undefined ? [] : value.split(',').map((entry) => entry.trim()).filter(Boolean);
