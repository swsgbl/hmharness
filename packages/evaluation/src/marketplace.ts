/**
 * @hmharness/evaluation - Benchmark Marketplace (P2-07)
 *
 * The audit called for: "允许外部贡献任务，但生产 gate 只读取签名/审核后的 fixture"
 *
 * Provides governance for external benchmark contributions:
 * 1. Contribution submission with metadata
 * 2. Review/approval workflow
 * 3. Signature verification (simulated - real crypto in production)
 * 4. Registry of approved vs pending vs rejected fixtures
 */

export type FixtureStatus = 'pending' | 'approved' | 'rejected' | 'deprecated';

export interface BenchmarkFixture {
  id: string;
  name: string;
  description: string;
  category: string;
  difficulty: 1 | 2 | 3;
  prompt: string;
  expectedOutput: string;
  assertionType: 'exact' | 'contains' | 'regex';
  assertionValue: string;
  /** contributor metadata */
  contributor: string;
  submittedAt: string;
  /** governance */
  status: FixtureStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNotes?: string;
  /** content hash for integrity verification */
  contentHash: string;
  /** signature (simulated - real HMAC in production) */
  signature?: string;
}

export interface MarketplaceStats {
  total: number;
  approved: number;
  pending: number;
  rejected: number;
  byCategory: Record<string, number>;
}

/**
 * Compute a content hash for a fixture (simple but deterministic).
 * Pure - testable.
 */
export function hashFixture(fixture: Omit<BenchmarkFixture, 'contentHash' | 'status' | 'submittedAt'>): string {
  const content = JSON.stringify({
    name: fixture.name, prompt: fixture.prompt,
    expected: fixture.expectedOutput, assertion: fixture.assertionValue,
  });
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
  }
  return `fx-${Math.abs(hash).toString(16).padStart(8, '0')}`;
}

/**
 * Sign a fixture (simulated HMAC).
 * Pure - testable.
 */
export function signFixture(fixture: BenchmarkFixture, secret: string): string {
  const payload = `${fixture.id}:${fixture.contentHash}:${secret}`;
  let hash = 0;
  for (let i = 0; i < payload.length; i++) {
    hash = ((hash << 5) - hash + payload.charCodeAt(i)) | 0;
  }
  return `sig-${Math.abs(hash).toString(16)}`;
}

/**
 * Verify a fixture signature.
 * Pure - testable.
 */
export function verifySignature(fixture: BenchmarkFixture, secret: string): boolean {
  if (!fixture.signature) return false;
  return fixture.signature === signFixture(fixture, secret);
}

/**
 * Validate a contributed fixture for completeness.
 * Pure - testable.
 */
export function validateFixture(fixture: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const f = fixture as Partial<BenchmarkFixture>;
  if (!f.name) errors.push('name is required');
  if (!f.prompt) errors.push('prompt is required');
  if (!f.contributor) errors.push('contributor is required');
  if (!f.category) errors.push('category is required');
  if (f.difficulty === undefined || ![1, 2, 3].includes(f.difficulty)) errors.push('difficulty must be 1, 2, or 3');
  if (!f.assertionType || !['exact', 'contains', 'regex'].includes(f.assertionType)) errors.push('assertionType must be exact/contains/regex');
  if (!f.assertionValue) errors.push('assertionValue is required');
  return { valid: errors.length === 0, errors };
}

/**
 * The fixture registry - manages the marketplace lifecycle.
 */
export class FixtureRegistry {
  private fixtures = new Map<string, BenchmarkFixture>();

  submit(fixture: BenchmarkFixture): { ok: boolean; reason?: string } {
    const v = validateFixture(fixture);
    if (!v.valid) return { ok: false, reason: v.errors.join('; ') };
    if (this.fixtures.has(fixture.id)) return { ok: false, reason: `fixture ${fixture.id} already exists` };
    this.fixtures.set(fixture.id, fixture);
    return { ok: true };
  }

  review(id: string, approved: boolean, reviewer: string, notes?: string): boolean {
    const f = this.fixtures.get(id);
    if (!f) return false;
    f.status = approved ? 'approved' : 'rejected';
    f.reviewedBy = reviewer;
    f.reviewedAt = new Date().toISOString();
    f.reviewNotes = notes;
    return true;
  }

  deprecate(id: string): boolean {
    const f = this.fixtures.get(id);
    if (!f) return false;
    f.status = 'deprecated';
    return true;
  }

  /** Only approved fixtures are usable in production gates */
  getApproved(): BenchmarkFixture[] {
    return [...this.fixtures.values()].filter(f => f.status === 'approved');
  }

  getPending(): BenchmarkFixture[] {
    return [...this.fixtures.values()].filter(f => f.status === 'pending');
  }

  get(id: string): BenchmarkFixture | undefined {
    return this.fixtures.get(id);
  }

  stats(): MarketplaceStats {
    const all = [...this.fixtures.values()];
    const byCategory: Record<string, number> = {};
    for (const f of all) byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
    return {
      total: all.length,
      approved: all.filter(f => f.status === 'approved').length,
      pending: all.filter(f => f.status === 'pending').length,
      rejected: all.filter(f => f.status === 'rejected').length,
      byCategory,
    };
  }
}
