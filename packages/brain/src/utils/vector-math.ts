import { invalidArgument } from '../errors/index.js';
import type { SimilarityMetric, Vector } from '../types/index.js';

const assertSameDimension = (left: Vector, right: Vector): void => {
  if (left.length !== right.length) {
    throw invalidArgument(`Vector dimensions differ: ${left.length} vs ${right.length}`);
  }
  if (left.length === 0) throw invalidArgument('Vectors must not be empty');
};

export const dotProduct = (left: Vector, right: Vector): number => {
  assertSameDimension(left, right);
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += (left[index] as number) * (right[index] as number);
  }
  return total;
};

export const magnitude = (vector: Vector): number => {
  if (vector.length === 0) throw invalidArgument('Vectors must not be empty');
  let total = 0;
  for (const component of vector) total += component * component;
  return Math.sqrt(total);
};

export const cosineSimilarity = (left: Vector, right: Vector): number => {
  const product = dotProduct(left, right);
  const denominator = magnitude(left) * magnitude(right);
  return denominator === 0 ? 0 : product / denominator;
};

export const euclideanDistance = (left: Vector, right: Vector): number => {
  assertSameDimension(left, right);
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    const delta = (left[index] as number) - (right[index] as number);
    total += delta * delta;
  }
  return Math.sqrt(total);
};

/** Normalizes a vector to unit length; zero vectors are returned unchanged. */
export const normalize = (vector: Vector): Vector => {
  const length = magnitude(vector);
  return length === 0 ? [...vector] : vector.map((component) => component / length);
};

/**
 * Computes a similarity score where larger always means "more similar",
 * allowing every metric to share one ranking path.
 */
export const similarity = (left: Vector, right: Vector, metric: SimilarityMetric): number => {
  switch (metric) {
    case 'cosine':
      return cosineSimilarity(left, right);
    case 'dot':
      return dotProduct(left, right);
    case 'euclidean':
      return 1 / (1 + euclideanDistance(left, right));
  }
};

/** Deterministic, dependency-free embedding used for local development and tests. */
export const hashEmbedding = (text: string, dimensions = 64): Vector => {
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw invalidArgument('Embedding dimensions must be a positive integer');
  }
  const buckets = new Array<number>(dimensions).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const token of tokens) {
    let hash = 2_166_136_261;
    for (let index = 0; index < token.length; index += 1) {
      hash ^= token.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619) >>> 0;
    }
    const bucket = hash % dimensions;
    buckets[bucket] = (buckets[bucket] ?? 0) + 1;
  }
  return normalize(buckets);
};
