import { createHash } from 'node:crypto';

/**
 * Canonical JSON for experiment manifests and data fingerprints.
 * Object keys are sorted recursively; arrays keep their original order because
 * order is meaningful for trajectory steps. This is for reproducibility, not
 * for signing untrusted data or handling cyclic objects.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, normalize(record[key])]),
    );
  }
  return value;
}

/**
 * Order-independent SHA-256 fingerprint of the complete dataset contents.
 * Each record is normalized separately then sorted; internal array order,
 * including trajectory step order, is preserved. Unlike an ID-only digest,
 * changes to outcomes/actions/metrics alter the fingerprint.
 */
export function contentFingerprint(records: readonly unknown[]): string {
  const canonicalRecords = records.map(canonicalJson).sort();
  return createHash('sha256')
    .update(canonicalRecords.join('\n') + (canonicalRecords.length > 0 ? '\n' : ''), 'utf8')
    .digest('hex');
}

/** Unbiased Fisher–Yates permutation given a deterministic RNG. */
export function seededShuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const raw = random();
    // Keep a faulty RNG from producing an out-of-range index or NaN.
    const sample = Number.isFinite(raw) ? Math.max(0, Math.min(0.9999999999999999, raw)) : 0.5;
    const j = Math.floor(sample * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
