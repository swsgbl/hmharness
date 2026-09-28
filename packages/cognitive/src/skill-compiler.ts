/**
 * @hmharness/cognitive - skill compiler (blueprint §8 / SK-001..010)
 *
 * Skills are EXECUTABLE, VERIFIABLE objects — not prose. A SkillSpec carries
 * trigger, preconditions, procedure (typed steps), verification specs and
 * evidence refs, versioned. Compilation mines episodic trajectories for
 * repeated action patterns that ended in success; every candidate MUST pass
 * its verification suite on a benchmark before promotion, and promotion is
 * reversible (SK-007/008) through the same governance path as evolution
 * candidates.
 */
import { stableHash } from './protocol.ts';
import type { CognitiveTrajectory } from './protocol.ts';

export interface Trigger {
  /** matched against goal text + observation affordances */
  keywords?: string[];
  environmentId?: string;
  actionTypes?: string[];
}

export interface Condition {
  description: string;
  /** structural expression checked by the host, e.g. "fs:exists(package.json)" */
  check: string;
}

export interface Step {
  kind: 'act' | 'verify' | 'note';
  /** for act: the action type to execute; for verify: the check id */
  ref: string;
  args?: Record<string, unknown>;
}

export interface VerificationSpec {
  id: string;
  /** host evaluator key, resolved by the benchmark runner */
  evaluator: string;
  expect: { metric: string; op: '>=' | '<=' | '=='; value: number };
}

export interface EvidenceRef {
  trajectoryId: string;
  steps: number;
  outcome: 'success' | 'failure' | 'unknown';
}

export interface SkillSpec {
  id: string;
  name: string;
  trigger: Trigger;
  preconditions: Condition[];
  procedure: Step[];
  verification: VerificationSpec[];
  evidence: EvidenceRef[];
  version: string;
  status: 'candidate' | 'active' | 'rolled-back';
  createdAt: string;
}

export interface VerificationResult {
  skillId: string;
  pass: boolean;
  checks: Array<{ id: string; metric: string; actual: number; expected: string; pass: boolean }>;
}

/** The benchmark surface the compiler verifies against — implemented by
 *  the environments/bench packages; kept as an interface for independence
 *  (evaluator independence rule: the compiler never grades its own work). */
export interface SkillBenchmark {
  runSkill(skill: SkillSpec): Promise<Record<string, number>>;
}

export class SkillCompiler {
  private skills = new Map<string, SkillSpec>();
  private lastVerification = new Map<string, VerificationResult>();

  list(): SkillSpec[] {
    return [...this.skills.values()];
  }

  get(id: string): SkillSpec | undefined {
    return this.skills.get(id);
  }

  /** SK-002. Mine successful trajectories for repeated action-type runs.
   *  A pattern must appear in >= minRepeat distinct successful episodes to
   *  become a candidate — one lucky run is folklore, not a skill. */
  async compile(experiences: CognitiveTrajectory[], opts?: { minRepeat?: number }): Promise<SkillSpec[]> {
    const minRepeat = opts?.minRepeat ?? 2;
    const patterns = new Map<string, { actionTypes: string[]; trajectories: CognitiveTrajectory[] }>();
    for (const traj of experiences) {
      if (!traj.metrics.success) continue;
      const run = longestSuccessfulRun(traj);
      if (run.length < 2) continue;
      const key = run.join('|');
      const p = patterns.get(key) ?? { actionTypes: run, trajectories: [] };
      p.trajectories.push(traj);
      patterns.set(key, p);
    }
    const out: SkillSpec[] = [];
    for (const [key, p] of patterns) {
      if (p.trajectories.length < minRepeat) continue;
      const envId = p.trajectories[0].environment.id;
      const skill: SkillSpec = {
        id: `skill-${stableHash(key).slice(0, 10)}`,
        name: `${p.actionTypes.join(' → ')} (${envId})`,
        trigger: { environmentId: envId, actionTypes: p.actionTypes },
        preconditions: [
          { description: `environment is ${envId}`, check: `env:id=${envId}` },
        ],
        procedure: p.actionTypes.map((t) => ({ kind: 'act' as const, ref: t })),
        verification: [
          { id: 'success-rate', evaluator: 'bench:run', expect: { metric: 'successRate', op: '>=', value: 0.8 } },
          { id: 'action-efficiency', evaluator: 'bench:run', expect: { metric: 'actionsPerSuccess', op: '<=', value: 1.5 * avgActions(p.trajectories) } },
        ],
        evidence: p.trajectories.map((t) => ({ trajectoryId: t.id, steps: t.metrics.actions, outcome: 'success' as const })),
        version: '0.1.0',
        status: 'candidate',
        createdAt: new Date().toISOString(),
      };
      this.skills.set(skill.id, skill);
      out.push(skill);
    }
    return out;
  }

  /** SK-004. Run the skill's verification specs against the benchmark. */
  async verify(skill: SkillSpec, benchmark: SkillBenchmark): Promise<VerificationResult> {
    const metrics = await benchmark.runSkill(skill);
    const checks = skill.verification.map((v) => {
      const actual = metrics[v.expect.metric] ?? Number.NaN;
      const pass =
        v.expect.op === '>=' ? actual >= v.expect.value
        : v.expect.op === '<=' ? actual <= v.expect.value
        : actual === v.expect.value;
      return { id: v.id, metric: v.expect.metric, actual, expected: `${v.expect.op} ${v.expect.value}`, pass: Number.isFinite(actual) && pass };
    });
    const result: VerificationResult = { skillId: skill.id, pass: checks.every((c) => c.pass), checks };
    this.lastVerification.set(skill.id, result);
    return result;
  }

  /** SK-007. Promote only candidates with a PASSING verification on record.
   *  No verification, no promotion — this is the whole point of the gate. */
  async promote(skillId: string): Promise<void> {
    const s = this.skills.get(skillId);
    if (!s) throw new Error(`unknown skill ${skillId}`);
    const verification = this.lastVerification.get(skillId);
    if (!verification?.pass) {
      throw new Error(`skill ${skillId} has no passing verification on record: run verify() against a benchmark first`);
    }
    if (s.status === 'active') return;
    s.status = 'active';
    s.version = bump(s.version);
  }

  /** SK-008. Rollback is always allowed. */
  async rollback(skillId: string): Promise<void> {
    const s = this.skills.get(skillId);
    if (!s) throw new Error(`unknown skill ${skillId}`);
    s.status = 'rolled-back';
  }
}

function longestSuccessfulRun(traj: CognitiveTrajectory): string[] {
  let best: string[] = [];
  let cur: string[] = [];
  for (const s of traj.steps) {
    if (s.outcome === 'success') {
      cur.push(s.action.type);
      if (cur.length > best.length) best = cur;
    } else {
      cur = [];
    }
  }
  return best;
}

function avgActions(trajs: CognitiveTrajectory[]): number {
  return trajs.reduce((s, t) => s + t.metrics.actions, 0) / trajs.length;
}

function bump(version: string): string {
  const [maj, min, patch] = version.split('.').map((n) => Number(n) || 0);
  return `${maj}.${min}.${patch + 1}`;
}
