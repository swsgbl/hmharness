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

/* ---------------- Skill 2.0 (weekly pack 0.25 Learning OS 2.0) ----------------
 *
 * The upgrade pack extends the skill schema to
 * precondition -> variables -> procedure -> expected state delta ->
 * verification -> counterexample. V1 already carries preconditions/
 * procedure/verification; V2 adds the rest as OPTIONAL fields so every
 * existing skill and test stays valid (compatibility layer first - the
 * pack's own rule). The Skill Generalization Lab (0.26) populates
 * counterexamples from real rejection analysis; honest miners leave
 * fields EMPTY rather than inventing content (absent is not null).
 */
export interface SkillVariable {
  name: string;
  description?: string;
  example?: string;
}

export interface SkillSpecV2 extends SkillSpec {
  /** named variables the procedure binds (mined from args when available) */
  variables?: SkillVariable[];
  /** what the world should look like after a successful run */
  expectedStateDelta?: Array<{ key: string; change: string }>;
  /** known counterexamples: situations where this skill MUST NOT fire */
  counterexamples?: Array<{ description: string; source: string }>;
  /** where this skill came from - trajectory ids / miner + version */
  provenance?: string;
  /** miner-estimated confidence in [0,1] */
  confidence?: number;
  /** environments this skill is known to apply in */
  environmentScope?: string[];
}

/** Honest adapter: a mined workflow becomes a V2 skill with EXACTLY the
 *  fields the data supports. Action-type n-grams cannot recover variable
 *  bindings or state deltas - those stay EMPTY (the Lab fills them when
 *  its analysis can), and empty is stated, never faked. */
export function toSkillSpecV2(
  candidate: WorkflowCandidate,
  opts: { provenance?: string; environmentScope?: string[] } = {},
): SkillSpecV2 {
  return {
    id: `skill-${candidate.environmentId}-${candidate.steps.join('-').slice(0, 40)}`,
    name: candidate.steps.slice(0, 3).join(' → '),
    trigger: { environmentId: candidate.environmentId, actionTypes: candidate.steps },
    preconditions: [],
    procedure: candidate.steps.map((ref) => ({ kind: 'act' as const, ref })),
    verification: [],
    evidence: candidate.trajectoryIds.map((id) => ({ trajectoryId: id, steps: 0, outcome: 'success' as const })),
    version: '2.0.0',
    status: 'candidate',
    createdAt: new Date().toISOString(),
    variables: [],
    expectedStateDelta: [],
    counterexamples: [],
    provenance: opts.provenance ?? `mineWorkflows (support ${candidate.support})`,
    confidence: Math.min(1, Number((candidate.support / 10).toFixed(2))),
    environmentScope: opts.environmentScope ?? [candidate.environmentId],
  };
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

/* ---------------- Skill Compiler 2.0 (review W10): generalized workflow mining + failure anti-patterns ---------------- */

export interface WorkflowCandidate {
  /** the consecutive action-type n-gram (the workflow body) */
  steps: string[];
  /** distinct successful trajectories containing the n-gram */
  support: number;
  trajectoryIds: string[];
  /** environment of the supporting episodes */
  environmentId: string;
}

/** Mine frequent consecutive action n-grams (n within [nMin,nMax]) across
 *  SUCCESSFUL trajectories, keeping only MAXIMAL ones (an n-gram fully
 *  contained in a longer supported n-gram of the same episodes adds nothing).
 *  This generalizes compile()'s exact full-sequence matching: a workflow
 *  survives when one episode has an extra step somewhere. */
export function mineWorkflows(experiences: CognitiveTrajectory[], opts: { minSupport?: number; nMin?: number; nMax?: number } = {}): WorkflowCandidate[] {
  const minSupport = opts.minSupport ?? 2;
  const nMin = opts.nMin ?? 2;
  const nMax = opts.nMax ?? 4;
  const table = new Map<string, { steps: string[]; trajs: Set<string>; env: string }>();
  for (const traj of experiences) {
    if (!traj.metrics.success) continue;
    const seq = traj.steps.filter((s) => s.outcome === 'success').map((s) => s.action.type);
    for (let n = nMin; n <= Math.min(nMax, seq.length); n++) {
      for (let i = 0; i + n <= seq.length; i++) {
        const gram = seq.slice(i, i + n);
        const key = gram.join('|');
        const agg = table.get(key) ?? { steps: gram, trajs: new Set<string>(), env: traj.environment.id };
        agg.trajs.add(traj.id);
        table.set(key, agg);
      }
    }
  }
  const supported = [...table.entries()]
    .filter(([, v]) => v.trajs.size >= minSupport)
    .map(([key, v]) => ({ key, steps: v.steps, support: v.trajs.size, trajectoryIds: [...v.trajs], environmentId: v.env }));
  // maximality: drop grams whose key is a contiguous substring of a longer
  // supported gram with support from a superset of episodes
  const kept = supported.filter((c) => {
    return !supported.some((d) => d !== c && d.steps.length > c.steps.length && d.key.includes(c.key) && d.support >= c.support);
  });
  return kept.sort((a, b) => b.steps.length - a.steps.length || b.support - a.support);
}

export interface AntiPattern {
  /** the action-type sequence that reliably PRECEDES failure */
  pattern: string[];
  /** failed trajectories ending right after this sequence */
  failures: number;
  trajectoryIds: string[];
  warning: string;
}

/** Mine failure anti-patterns: consecutive action runs that immediately
 *  precede the END of FAILED trajectories. These become warnings attached to
 *  skills (knowledge about what NOT to do), never procedures. */
export function mineAntiPatterns(experiences: CognitiveTrajectory[], opts: { minFailures?: number; nMax?: number } = {}): AntiPattern[] {
  const minFailures = opts.minFailures ?? 2;
  const nMax = opts.nMax ?? 3;
  const table = new Map<string, { steps: string[]; trajs: Set<string> }>();
  for (const traj of experiences) {
    if (traj.metrics.success) continue;
    const seq = traj.steps.map((s) => s.action.type);
    if (seq.length === 0) continue;
    for (let n = 1; n <= Math.min(nMax, seq.length); n++) {
      const gram = seq.slice(seq.length - n);
      const key = gram.join('|');
      const agg = table.get(key) ?? { steps: gram, trajs: new Set<string>() };
      agg.trajs.add(traj.id);
      table.set(key, agg);
    }
  }
  const all = [...table.entries()]
    .filter(([, v]) => v.trajs.size >= minFailures)
    .map(([key, v]) => ({ key, steps: v.steps, failures: v.trajs.size, trajectoryIds: [...v.trajs] }));
  // maximality (same rule as workflows): drop a gram fully contained in a
  // longer supported gram — the longer one carries the actionable context
  const kept = all.filter((c) => !all.some((d) => d !== c && d.steps.length > c.steps.length && d.key.endsWith(c.key) && d.failures >= c.failures));
  return kept
    .map((c): AntiPattern => ({ pattern: c.steps, failures: c.failures, trajectoryIds: c.trajectoryIds, warning: `avoid ${c.key}: preceded the failure end in ${c.failures} failed runs` }))
    .sort((a, b) => b.failures - a.failures || b.pattern.length - a.pattern.length);
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
