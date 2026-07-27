let sequence = 0;

const randomSegment = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID().replaceAll('-', '');
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  sequence = (sequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}${sequence.toString(36)}`;
};

export const createId = (prefix = 'nx'): string => `${prefix}_${randomSegment()}`;
