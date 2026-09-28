/**
 * @hmharness/evolution - cognitive audit bridge (blueprint EV-002/EV-011/EV-012)
 *
 * Every evolve-loop outcome lands in the IMMUTABLE cognitive audit trail
 * (HMH_HOME/cognitive/evolution/audit.jsonl) with the blueprint's candidate
 * contract when the draft declares one:
 *
 *   Hypothesis: <what changes and why it should work>
 *   Expected: <metric op value>
 *   Regression: <what this could hurt>
 *
 * Drafts WITHOUT declarations still audit (declared:false) — visible
 * honesty, not silent acceptance. Teams can enforce the blueprint strictly
 * with evolution.requireContract=true in config: undeclared candidates are
 * then rejected before any bench spend.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { detectRewardHacking } from '@hmharness/cognitive';

export interface EvolutionOutcomeLike {
  name: string;
  action: 'promoted' | 'rejected' | 'error';
  reason: string;
  baseline?: { passRate: number };
  candidate?: { passRate: number };
  holdout?: { baselineRate: number; candidateRate: number };
  lineage?: { parentInsights?: string[]; scores?: Record<string, number | undefined>; metaModel?: string; decidedAt?: string };
}

export interface SkillContract {
  hypothesis: string;
  expected: string;
  regression: string;
}

/** Parse the blueprint declaration header from a skill draft's markdown. */
export function parseSkillContract(skillMd: string): SkillContract | null {
  const grab = (key: string): string => {
    const m = skillMd.match(new RegExp(`^\\s*${key}\\s*[:：]\\s*(.+)$`, 'mi'));
    return m?.[1]?.trim() ?? '';
  };
  const hypothesis = grab('Hypothesis');
  const expected = grab('Expected');
  const regression = grab('Regression');
  if (!hypothesis || !regression) return null;
  return { hypothesis, expected: expected || 'unspecified', regression };
}

export interface AuditEvent {
  at: string;
  event: 'promoted' | 'rejected' | 'error' | 'rolled-back' | 'contract-rejected';
  candidateId: string;
  target: string;
  hypothesis: string;
  detail: Record<string, unknown>;
}

/** Append one outcome to the immutable audit trail (best-effort, never throws). */
export async function auditEvolutionOutcome(home: string, outcome: EvolutionOutcomeLike, skillMd?: string): Promise<void> {
  try {
    const contract = skillMd ? parseSkillContract(skillMd) : null;
    const event: AuditEvent = {
      at: outcome.lineage?.decidedAt ?? new Date().toISOString(),
      event: outcome.action === 'promoted' ? 'promoted' : outcome.action === 'rejected' ? /rolled back/i.test(outcome.reason) ? 'rolled-back' : 'rejected' : 'error',
      candidateId: outcome.name,
      target: 'skill',
      hypothesis: contract?.hypothesis ?? '(undeclared draft — no Hypothesis/Regression header)',
      detail: {
        reason: outcome.reason,
        declared: Boolean(contract),
        contract,
        trainBaseline: outcome.baseline?.passRate,
        trainCandidate: outcome.candidate?.passRate,
        holdoutBaseline: outcome.holdout?.baselineRate,
        holdoutCandidate: outcome.holdout?.candidateRate,
        lineage: outcome.lineage,
      },
    };
    const dir = join(home, 'cognitive', 'evolution');
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, 'audit.jsonl'), JSON.stringify(event) + '\n', 'utf8');
  } catch {
    /* audit is best-effort by contract */
  }
}

/** EV-012 at the canary/impact seam: bench pass-rate is the METRIC; real
 *  sessions' impact delta is the TASK. Metric up + task flat = Goodhart. */
export function checkCanaryRewardHacking(input: {
  benchPassRateBefore: number;
  benchPassRateAfter: number;
  realTaskSuccessBefore: number;
  realTaskSuccessAfter: number;
}): { hacked: boolean; reason?: string } {
  return detectRewardHacking({
    metricBefore: input.benchPassRateBefore,
    metricAfter: input.benchPassRateAfter,
    realTaskSuccessBefore: input.realTaskSuccessBefore,
    realTaskSuccessAfter: input.realTaskSuccessAfter,
  });
}

/** Strict mode gate (evolution.requireContract=true): undeclared drafts are
 *  rejected BEFORE bench spend, with an audit trail entry saying why. */
export async function enforceContractGate(home: string, name: string, skillMd: string, requireContract: boolean): Promise<{ pass: boolean; contract: SkillContract | null }> {
  const contract = parseSkillContract(skillMd);
  if (contract || !requireContract) return { pass: true, contract };
  await auditEvolutionOutcome(home, {
    name,
    action: 'rejected',
    reason: 'evolution.requireContract=true and the draft has no Hypothesis/Regression declaration (blueprint EV-002 contract gate)',
  }, skillMd);
  return { pass: false, contract: null };
}
