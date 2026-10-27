/**
 * Three-arm main experiment driver (Issue #22, P1, 2026-10-27).
 *
 * Subcommands (run in order; each is resumable):
 *   setup    - freeze the manifest: task set + datasetHash, skill snapshot,
 *              gate home, protect dir (read-only), all pre-registered params
 *   phase0   - null/control: arm A over train+protect, 3 seeds (variance est)
 *   phase1   - candidate generation from TRAIN-only null failures (frozen meta-model)
 *   phase2   - the real evolution gate (runEvolution, preset proposal)
 *   phase3   - main experiment: A/B/C x (train+protect) x 3 seeds, shuffled order
 *
 * Honesty rules baked in:
 *  - phase1 reads ONLY train-class null records (protect never feeds the
 *    candidate) and the driver asserts the protect dir is byte-identical
 *    before/after every phase that could touch it
 *  - the C arm runs ONLY if the gate promoted the candidate; otherwise it is
 *    honestly reported as not deployable (never force-injected)
 *  - one JSON line per run on disk, BEFORE any analysis runs
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync, chmodSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chat } from '../packages/kernel/src/provider.ts';
import { runLoop, type LoopEvents } from '../packages/kernel/src/loop.ts';
import { Registry } from '../packages/kernel/src/registry.ts';
import { baseTools } from '../packages/agent/src/tools.ts';
import { buildSystemPrompt } from '../packages/agent/src/prompt.ts';
import type { BenchCase } from '../packages/evolution/src/bench.ts';
import { runEvolution, screenForPoison, type CaseRunner } from '../packages/evolution/src/evolve.ts';
import {
  EXPERIMENT_ID, SEEDS, SHUFFLE_SEED_MATERIAL, GATE_VAL_SIZE, FAMILY_QUOTAS,
  selectTasks, buildTaskSetHash, judgeOutput, snapshotToPrompt, candidateInjection,
  buildAdaptiveBlock, familyOf, type ExperimentTask, type RunRecord, type SkillSnapshotEntry, type TaskLesson,
} from '../packages/evolution/src/three-arm.ts';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REAL_HOME = join(homedir(), '.hmharness');
const EXP = join(REPO_ROOT, 'website', 'evidence', 'experiments', 'three-arm-2026-10-27');
const PHASES = join(EXP, 'phases');
const GATE_HOME = join(EXP, 'gate-home');
const PROTECT_DIR = join(EXP, 'protect');
const SNAPSHOT_DIR = join(EXP, 'skills-snapshot');

/** Frozen base model: the machine's configured glm coding-plan provider.
 *  Sampling params: NONE are sent (provider default) — same wire shape for
 *  every arm, recorded in the manifest. */
function glmProvider(): { baseUrl: string; apiKey: string; model: string } {
  const cfg = JSON.parse(readFileSync(join(REAL_HOME, 'config.json'), 'utf8')) as {
    providers: Record<string, { baseUrl: string; apiKey: string; model: string }>;
  };
  return cfg.providers.glm!;
}

const SHA = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const REPO_COMMIT = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).toString().trim();
const MAX_TURNS = 6;

/* ---------------- task loading ---------------- */

function loadExperimentTasks(): { tasks: ExperimentTask[]; byId: Map<string, BenchCase>; excluded: Array<{ id: string; why: string }> } {
  // read the REAL home's case pool (it must already exist — the corpus is
  // the machine's, not something this experiment may mutate)
  const all = listCasesSync(REAL_HOME);
  const sel = selectTasks(all.map((c) => ({ id: c.name, holdout: c.holdout, tools: c.tools })), 20261027);
  const tasks: ExperimentTask[] = [];
  for (const id of [...sel.train, ...sel.protect]) {
    const c = all.find((x) => x.name === id)!;
    const raw = readFileSync(join(REAL_HOME, 'bench', 'cases', `${id}.task`), 'utf8');
    tasks.push({
      id: c.name,
      prompt: c.prompt,
      assertion: { expect: c.expect, expectExact: c.expectExact, expectRegex: c.expectRegex, expectNone: c.expectNone, expectAny: c.expectAny },
      tools: c.tools,
      holdout: c.holdout,
      split: sel.protect.includes(id) ? 'protect' : 'train',
      family: familyOf(id),
      fileSha: SHA(raw),
    });
  }
  return { tasks, byId: new Map(all.map((c) => [c.name, c])), excluded: sel.excluded };
}

function listCasesSync(home: string): BenchCase[] {
  // listCases is async in bench.ts; the pool is tiny so inline the same parse
  const dir = join(home, 'bench', 'cases');
  return readdirSync(dir).filter((f) => f.endsWith('.task')).sort().map((f) => {
    const raw = readFileSync(join(dir, f), 'utf8').trim();
    const lines = raw.split('\n');
    const pick = (key: string) => { const l = lines.find((x) => x.startsWith(key + ':')); return l ? l.slice(key.length + 1).trim() : undefined; };
    const list = (key: string) => { const v = pick(key); return v ? v.split(/&&|\|\|/).map((s) => s.trim()).filter(Boolean) : undefined; };
    return {
      name: f.replace(/\.task$/, ''),
      prompt: lines[0]!,
      expect: list('expect') ?? [],
      expectExact: pick('expect-exact')?.replace(/^"|"$/g, ''),
      expectRegex: pick('expect-regex'),
      expectNone: list('expect-none'),
      expectAny: list('expect-any'),
      tools: pick('tools') === 'loop',
      holdout: pick('holdout') === 'true',
      costCap: undefined,
    } as BenchCase;
  });
}

/* ---------------- protect-dir integrity ---------------- */

function protectFingerprint(): string {
  const files = readdirSync(PROTECT_DIR).filter((f) => f.endsWith('.task')).sort();
  return SHA(files.map((f) => f + ':' + SHA(readFileSync(join(PROTECT_DIR, f)))).join('\n'));
}

function snapshotFingerprint(): string {
  const entries: string[] = [];
  const walk = (dir: string, rel: string) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      const st = statSync(p);
      entries.push(st.isDirectory() ? rel + f + '/dir' : rel + f + ':' + SHA(readFileSync(p)));
      if (st.isDirectory()) walk(p, rel + f + '/');
    }
  };
  walk(SNAPSHOT_DIR, '');
  return SHA(entries.join('\n'));
}

function setWritable(dir: string, writable: boolean): void {
  for (const f of readdirSync(dir)) chmodSync(join(dir, f), writable ? 0o666 : 0o444);
}

/** MUST stay byte-identical to evolution/skills.ts#parseDescription: the
 *  gate's baseline injection (skillsToPrompt over listSkills) and this
 *  driver's A/B/C snapshot injection must extract the SAME description
 *  strings, or the gate's baseline is not the main experiment's arm A
 *  (found 2026-10-27 mid-phase0: 5/34 skills diverged; that run was voided). */
function parseDescriptionLikeSkillsTs(text: string): string {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const m = fm[1].match(/^description:\s*(.+)$/m);
    if (m) return m[1].trim().slice(0, 120);
  }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#') && !t.startsWith('---')) return t.slice(0, 120);
  }
  return '';
}

function snapshotEntries(dir: string): SkillSnapshotEntry[] {
  return readdirSync(dir).filter((d) => {
    try { return statSync(join(dir, d, 'SKILL.md')).isFile(); } catch { return false; }
  }).sort().map((d) => ({ name: d, description: parseDescriptionLikeSkillsTs(readFileSync(join(dir, d, 'SKILL.md'), 'utf8')) }));
}

/* ---------------- the frozen runner (shared by all arms + gate) ---------------- */

function makeRunner(provider: { baseUrl: string; apiKey: string; model: string }) {
  return async (c: { prompt: string; tools: boolean }, systemPrompt: string): Promise<{
    output: string; usage: { promptTokens: number | null; completionTokens: number | null }; toolCalls: number; recoveries: number;
  }> => {
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: c.prompt },
    ];
    if (!c.tools) {
      const r = await chat(provider, messages);
      return {
        output: r.message.content ?? '',
        usage: { promptTokens: r.usage?.prompt_tokens ?? null, completionTokens: r.usage?.completion_tokens ?? null },
        toolCalls: 0, recoveries: 0,
      };
    }
    const reg = new Registry();
    reg.registerAll(baseTools.filter((t) => t.name === 'read_file' || t.name === 'list_dir'));
    let recoveries = 0;
    const events: LoopEvents = { onToolResult: (_n, _o, isError) => { if (isError) recoveries++; } };
    const res = await runLoop({ provider, registry: reg, messages, ctx: { cwd: REPO_ROOT, home: EXP }, maxTurns: MAX_TURNS, maxTotalTurns: MAX_TURNS, events });
    return {
      output: res.text,
      usage: { promptTokens: res.usage.promptTokens || null, completionTokens: res.usage.completionTokens || null },
      toolCalls: res.toolUses,
      recoveries,
    };
  };
}

function systemPromptFor(skillsBlock: string, extra?: string): string {
  const base = buildSystemPrompt({ cwd: REPO_ROOT, home: EXP, memory: '', skills: skillsBlock, insights: '', cognitive: '', model: 'glm-5.3' });
  return extra ? `${base}\n\n${extra}` : base;
}

/* ---------------- record IO + resume ---------------- */

function appendRecord(file: string, r: RunRecord): void {
  appendFileSync(file, JSON.stringify(r) + '\n', 'utf8');
}

function loadRecords(file: string): RunRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as RunRecord);
}

/* arm-blind predictions: one line per (seed, taskId), shared by all arms */
function appendPrediction(file: string, seed: number, taskId: string, p: number | null): void {
  appendFileSync(file, JSON.stringify({ seed, taskId, p }) + '\n', 'utf8');
}
function loadPredictions(file: string): Map<string, number | null> {
  if (!existsSync(file)) return new Map();
  return new Map(readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    const j = JSON.parse(l) as { seed: number; taskId: string; p: number | null };
    return [`${j.seed}:${j.taskId}`, j.p];
  }));
}

function recordKey(r: Pick<RunRecord, 'arm' | 'seed' | 'taskId'>): string { return `${r.arm}:${r.seed}:${r.taskId}`; }

/* ---------------- prediction (secondary metric) ---------------- */

const PREDICT_PROMPT = (taskPrompt: string) =>
  `A coding agent will execute the task below. Its final output will be checked by a programmatic assertion (exact text / exact regex / substring markers — machine-judged, not model-judged). Predict the probability (a single decimal between 0 and 1) that the agent's final output will PASS that assertion. Reply with ONLY the number.\n\nTask: ${taskPrompt}`;

function parseProb(text: string): number | null {
  const m = text.match(/(0(?:\.\d+)?|1(?:\.0+)?)/);
  if (!m) return null;
  const v = Number(m[1]);
  return v >= 0 && v <= 1 ? v : null;
}

/* ---------------- setup ---------------- */

function cmdSetup(): void {
  mkdirSync(PHASES, { recursive: true });
  const { tasks, excluded } = loadExperimentTasks();
  const { datasetHash } = buildTaskSetHash(tasks);
  const train = tasks.filter((t) => t.split === 'train');
  const protect = tasks.filter((t) => t.split === 'protect');

  // skill snapshot: the real home's active library, copied verbatim
  rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
  cpSync(join(REAL_HOME, 'skills', 'active'), SNAPSHOT_DIR, { recursive: true });
  const snapshot: SkillSnapshotEntry[] = snapshotEntries(SNAPSHOT_DIR);

  // protect dir: read-only copies of the holdout tasks (evolution never writes here)
  rmSync(PROTECT_DIR, { recursive: true, force: true });
  mkdirSync(PROTECT_DIR, { recursive: true });
  for (const t of protect) {
    writeFileSync(join(PROTECT_DIR, `${t.id}.task`), readFileSync(join(REAL_HOME, 'bench', 'cases', `${t.id}.task`)));
    chmodSync(join(PROTECT_DIR, `${t.id}.task`), 0o444);
  }

  // gate home: gate-train (no holdout flag) + gate-val (holdout: true added);
  // gate-val is a seeded shuffle so no family monopolizes the gate's holdout
  rmSync(GATE_HOME, { recursive: true, force: true });
  mkdirSync(join(GATE_HOME, 'bench', 'cases'), { recursive: true });
  const gateVal = new Set(seededShuffle(train.map((t) => t.id), EXPERIMENT_ID + ':gate-val').slice(0, GATE_VAL_SIZE));
  for (const t of train) {
    const raw = readFileSync(join(REAL_HOME, 'bench', 'cases', `${t.id}.task`), 'utf8');
    writeFileSync(join(GATE_HOME, 'bench', 'cases', `${t.id}.task`), gateVal.has(t.id) ? `${raw.trim()}\nholdout: true\n` : raw);
  }
  cpSync(SNAPSHOT_DIR, join(GATE_HOME, 'skills', 'active'), { recursive: true });

  const manifest = {
    experimentId: EXPERIMENT_ID,
    createdAt: new Date().toISOString(),
    repoCommit: REPO_COMMIT,
    design: {
      arms: {
        A: 'baseline: frozen skill-library snapshot injected, nothing else',
        B: 'task-adaptive: snapshot + per-task adaptation block built from TRAIN-family null failures, injected for this task only, never persisted',
        C: 'persistent-evolved: snapshot + the gate-promoted candidate skill (same injection construction as the evolution gate)',
      },
      question: 'does one persistable harness/skill change raise task success under a frozen base model without breaking the protection set?',
    },
    frozen: {
      baseModel: { provider: 'zhipu-coding-plan', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', id: 'glm-5.3', sampling: 'no sampling params sent (provider default) — identical wire shape in all arms' },
      systemPrompt: { builder: 'packages/agent/src/prompt.ts buildSystemPrompt', params: { cwd: REPO_ROOT, memory: '', insights: '', cognitive: '', locale: undefined, agentsMd: undefined, goal: undefined, model: 'glm-5.3' }, note: 'arm differences enter ONLY via the skills block (A/B/C) and the B-arm trailing adaptation block' },
      maxTurns: MAX_TURNS,
      toolWhitelist: ['read_file', 'list_dir'],
      contextPerTask: 'fresh session per run, no history carry-over',
      seeds: SEEDS,
      taskSet: {
        source: `${REAL_HOME}/bench/cases (the machine corpus, 91 train + 24 holdout precedent)`,
        familyQuotas: FAMILY_QUOTAS,
        selectionSeed: 20261027,
        gateValSize: GATE_VAL_SIZE,
        excluded: excluded,
        counts: { train: train.length, protect: protect.length },
        datasetHash,
        protectFiles: readdirSync(PROTECT_DIR).sort(),
      },
      skillSnapshot: { count: snapshot.length, names: snapshot.map((s) => s.name), fingerprint: snapshotFingerprint() },
      prediction: { promptTemplateSha: SHA(PREDICT_PROMPT('<task>')), note: 'same frozen model, task-only (arm-blind), parsed as first 0..1 decimal; unparseable => null (never 0)' },
      candidateProposal: { model: 'glm-5.3 (same frozen provider)', maxAttempts: 3, note: 'prompt hash recorded in phases/1-candidate.json at generation time' },
    },
    preRegistered: {
      mainEndpoint: 'protect split, C-vs-A, task-level paired difference',
      significance: 'bootstrap 95% CI (task-level paired diff, 10k resamples, seeded) excludes 0 OR any per-seed exact McNemar p < 0.05',
      exploratory: ['protect B-vs-A', 'train C-vs-A', 'train B-vs-A'],
      promotionGate: { maxProtectFallback: 0.03, maxCostGrowth: 0.10, minTasksPerSplit: 15, minDiscordantCells: 8 },
      cArmRule: 'C runs ONLY with a gate-promoted candidate; 3 rejected attempts => C reported as not deployable (NEEDS-DATA on the main endpoint)',
      crashRule: 'crashed runs count as task failure in the primary analysis AND are reported separately (crash rate per arm)',
    },
    phases: ['setup', 'phase0-null', 'phase1-candidate', 'phase2-gate', 'phase3-main', 'phase4-analysis'],
  };
  const manifestFile = join(EXP, 'manifest.json');
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`setup done: train=${train.length} protect=${protect.length} snapshotSkills=${snapshot.length}`);
  console.log(`datasetHash=${datasetHash}`);
  console.log(`manifestSha256=${SHA(readFileSync(manifestFile, 'utf8'))}`);
  console.log(`protectFingerprint=${protectFingerprint()}`);
  console.log('train tasks:', train.map((t) => t.id).join(', '));
  console.log('protect tasks:', protect.map((t) => t.id).join(', '));
}

/* ---------------- phase 0 / 3 shared execution ---------------- */

interface ExecOpts {
  phase: string;
  arms: Array<'A' | 'B' | 'C'>;
  datasetHash: string;
  tasks: ExperimentTask[];
  snapshot: SkillSnapshotEntry[];
  candidate?: { name: string; skillMd: string };
  predictFile: string;
  outFile: string;
  outDir: string;
}

async function execPhase(o: ExecOpts): Promise<void> {
  const provider = glmProvider();
  const runner = makeRunner(provider);
  mkdirSync(o.outDir, { recursive: true });
  const done = new Set(loadRecords(o.outFile).map(recordKey));
  const predictions = loadPredictions(o.predictFile);

  const total = o.tasks.length * o.arms.length * SEEDS.length;
  let n = 0;
  for (const seed of SEEDS) {
    // randomized execution order over (task, arm) pairs within each seed
    const cells: Array<{ task: ExperimentTask; arm: 'A' | 'B' | 'C' }> = [];
    for (const task of o.tasks) for (const arm of o.arms) cells.push({ task, arm });
    const order = seededShuffle(cells.map((c) => `${c.arm}|${c.task.id}`), SHUFFLE_SEED_MATERIAL + ':' + seed)
      .map((k) => { const [arm, id] = k.split('|'); return { task: o.tasks.find((t) => t.id === id)!, arm: arm as 'A' | 'B' | 'C' }; });

    for (const { task, arm } of order) {
      n++;
      if (done.has(`${arm}:${seed}:${task.id}`)) continue;
      // prediction (arm-blind): once per (task, seed), shared across arms
      let predictedP: number | null = null;
      const pKey = `${seed}:${task.id}`;
      if (!predictions.has(pKey)) {
        try {
          const pr = await chat(provider, [{ role: 'user', content: PREDICT_PROMPT(task.prompt) }]);
          predictedP = parseProb(pr.message.content ?? '');
        } catch { predictedP = null; }
        predictions.set(pKey, predictedP);
        appendPrediction(o.predictFile, seed, task.id, predictedP);
      } else predictedP = predictions.get(pKey) ?? null;

      // arm injection
      let system: string;
      if (arm === 'A') system = systemPromptFor(snapshotToPrompt(o.snapshot));
      else if (arm === 'B') system = systemPromptFor(snapshotToPrompt(o.snapshot), buildAdaptiveBlock(task.family, lessonsFor(task.family)));
      else {
        if (!o.candidate) { appendRecord(o.outFile, crashRecord('C', o.datasetHash, seed, task, 'C-arm not deployable: gate rejected all candidate versions', null)); continue; }
        system = systemPromptFor(candidateInjection(o.snapshot, o.candidate.name, o.candidate.skillMd));
      }

      const t0 = Date.now();
      try {
        const r = await runner(task, system);
        const verdict = judgeOutput(r.output, task);
        const wallMs = Date.now() - t0;
        const totalTokens = (r.usage.promptTokens ?? 0) + (r.usage.completionTokens ?? 0) || null;
        writeFileSync(join(o.outDir, `${seed}-${arm}-${task.id}.txt`), r.output, 'utf8');
        const rec: RunRecord = {
          experimentId: EXPERIMENT_ID, repoCommit: REPO_COMMIT, datasetHash: o.datasetHash,
          baseModel: { provider: 'zhipu-coding-plan', id: 'glm-5.3', sampling: 'provider-default' },
          arm, seed, taskId: task.id, holdoutClass: task.split,
          outcome: { success: verdict.pass, environmentDeltaHash: SHA(JSON.stringify({ finalOutput: SHA(r.output), toolCalls: r.toolCalls })) },
          metrics: {
            cost: { promptTokens: r.usage.promptTokens, completionTokens: r.usage.completionTokens, totalTokens, usd: null },
            wallMs, toolCalls: r.toolCalls, recoveries: r.recoveries, crashes: 0,
            falseCompletion: verdict.falseCompletion ? 1 : 0,
            predictedP, brier: predictedP === null ? null : Number(((predictedP - (verdict.pass ? 1 : 0)) ** 2).toFixed(4)),
          },
          safety: { backend: 'glm-coding-plan API (open.bigmodel.cn)', isolationLevel: 'read-only tools (read_file/list_dir); no shell; no network tools; fresh session per task' },
          decision: 'measured', reason: verdict.detail,
        };
        appendRecord(o.outFile, rec);
        console.log(`[${n}/${total}] seed${seed} ${arm} ${task.id} -> ${verdict.pass ? 'PASS' : 'FAIL'} (${wallMs}ms, ${totalTokens ?? '?'}tok)`);
      } catch (err) {
        const wallMs = Date.now() - t0;
        appendRecord(o.outFile, crashRecord(arm, o.datasetHash, seed, task, String(err).slice(0, 300), wallMs));
        console.log(`[${n}/${total}] seed${seed} ${arm} ${task.id} -> CRASH ${String(err).slice(0, 80)}`);
      }
    }
  }
  console.log(`phase ${o.phase} complete: ${loadRecords(o.outFile).length} records in ${o.outFile}`);
}

function crashRecord(arm: 'A' | 'B' | 'C', datasetHash: string, seed: number, task: ExperimentTask, reason: string, wallMs: number | null): RunRecord {
  return {
    experimentId: EXPERIMENT_ID, repoCommit: REPO_COMMIT, datasetHash,
    baseModel: { provider: 'zhipu-coding-plan', id: 'glm-5.3', sampling: 'provider-default' },
    arm, seed, taskId: task.id, holdoutClass: task.split,
    outcome: { success: null, environmentDeltaHash: 'crash' },
    metrics: { cost: { promptTokens: null, completionTokens: null, totalTokens: null, usd: null }, wallMs: wallMs ?? 0, toolCalls: 0, recoveries: 0, crashes: 1, falseCompletion: 0, predictedP: null, brier: null },
    safety: { backend: 'glm-coding-plan API', isolationLevel: 'read-only tools' },
    decision: 'crash', reason,
  };
}

function seededShuffle(items: string[], material: string): string[] {
  let a = createHash('sha256').update(material).digest().readUInt32BE(0) >>> 0;
  const rand = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [arr[i], arr[j]] = [arr[j]!, arr[i]!]; }
  return arr;
}

/* ---------------- lessons (B arm, from phase-0 TRAIN failures only) ---------------- */

function lessonsFor(family: string): TaskLesson[] {
  const file = join(PHASES, '0-null.jsonl');
  if (!existsSync(file)) return [];
  const nulls = loadRecords(file).filter((r) => r.arm === 'A' && r.holdoutClass === 'train' && r.decision === 'measured');
  // tasks of this family that ever failed in null; deterministic pick: most-failed first, then id
  const failCount = new Map<string, number>();
  for (const r of nulls) if (r.outcome.success !== true) failCount.set(r.taskId, (failCount.get(r.taskId) ?? 0) + 1);
  const ids = [...failCount.entries()].filter(([id]) => familyOf(id) === family)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map(([id]) => id);
  const out: TaskLesson[] = [];
  for (const id of ids) {
    const task = ALL_TASKS.get(id);
    // read the output of an ACTUAL failed run (its own seed's file)
    const failed = nulls.find((r) => r.taskId === id && r.outcome.success !== true);
    const outFile = failed ? join(PHASES, '0-outputs', `${failed.seed}-A-${id}.txt`) : '';
    let head = '';
    if (outFile && existsSync(outFile)) head = readFileSync(outFile, 'utf8').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (task && failed) out.push({ taskId: id, promptHead: task.prompt.replace(/\s+/g, ' ').slice(0, 80), failedOutputHead: head || '(no output captured)', failureDetail: failed.reason.slice(0, 60) });
  }
  return out;
}

/* ---------------- phase commands ---------------- */

async function cmdPhase0(): Promise<void> {
  const { tasks } = loadExperimentTasks();
  const { datasetHash } = buildTaskSetHash(tasks);
  const snapshot = loadSnapshot();
  const protectBefore = protectFingerprint();
  await execPhase({
    phase: '0-null', arms: ['A'], datasetHash, tasks, snapshot,
    predictFile: join(PHASES, 'predictions.jsonl'),
    outFile: join(PHASES, '0-null.jsonl'), outDir: join(PHASES, '0-outputs'),
  });
  assertSame('phase0', protectBefore, protectFingerprint(), 'protect');
}

async function cmdPhase1(): Promise<void> {
  const provider = glmProvider();
  const nulls = loadRecords(join(PHASES, '0-null.jsonl')).filter((r) => r.holdoutClass === 'train' && r.decision === 'measured');
  if (nulls.length === 0) throw new Error('phase0 produced no train records');
  // deterministic failure digest: tasks that never passed, then flippers; id-sorted
  const byTask = new Map<string, { pass: number; fail: number; failSeed?: number }>();
  for (const r of nulls) {
    const t = byTask.get(r.taskId) ?? { pass: 0, fail: 0 };
    if (r.outcome.success === true) t.pass++; else { t.fail++; t.failSeed ??= r.seed; }
    byTask.set(r.taskId, t);
  }
  const ranked = [...byTask.entries()]
    .map(([id, c]) => ({ id, allFail: c.pass === 0, failCount: c.fail, failSeed: c.failSeed }))
    .sort((a, b) => (Number(b.allFail) - Number(a.allFail)) || (b.failCount - a.failCount) || (a.id < b.id ? -1 : 1))
    .slice(0, 20);
  const samples = ranked.map((r) => {
    const task = ALL_TASKS.get(r.id)!;
    const f = join(PHASES, '0-outputs', `${r.failSeed}-A-${r.id}.txt`);
    const out = existsSync(f) ? readFileSync(f, 'utf8').trim().slice(0, 120) : '';
    return { task: r.id, prompt: task.prompt, failedOutput: out.replace(/\s+/g, ' '), passes: 3 - r.failCount };
  });

  const system = [
    'You are the evolution module of hmharness. A frozen base model repeatedly failed the exact-output bench tasks below.',
    'Write ONE skill (a terse how-to markdown doc the agent reads) that teaches how to pass such tasks: character-exact final replies, no preamble, no substitutions, fencing when helpful, reading the requested string back literally.',
    'Rules: name is kebab-case; description one line; skill_md at most 40 lines, imperative, NO example padding, NO instruction to add explanations; it must teach doing LESS, not more.',
    'Respond with ONLY a JSON object: {"name":"...","description":"...","skill_md":"..."}',
  ].join('\n');
  const user = `Failed-task digest from the null control (3 seeds each):\n${JSON.stringify(samples, null, 1)}\n\nPropose the single skill most likely to fix these failures without breaking anything else.`;
  const promptSha = SHA(system + '\n||\n' + user);

  const attempts: Array<Record<string, unknown>> = [];
  let cand: { name: string; description: string; skill_md: string } | null = null;
  const prevRejection = readCandidate()?.rejectedReason;
  for (let attempt = 1; attempt <= 3 && !cand; attempt++) {
    const r = await chat(provider, [
      { role: 'system', content: system },
      { role: 'user', content: user + (attempt > 1 && prevRejection ? `\n\nThe previous proposal was REJECTED by the gate because: ${prevRejection}. Propose a variation that fixes this.` : '') },
    ]);
    const raw = (r.message.content ?? '').replace(/```(?:json)?/g, '');
    const start = raw.indexOf('{');
    try {
      const parsed = JSON.parse(raw.slice(start, raw.lastIndexOf('}') + 1)) as { name: string; description?: string; skill_md: string };
      if (!/^[a-z0-9-]+$/.test(parsed.name) || !parsed.skill_md) throw new Error('malformed proposal');
      if (screenForPoison(parsed.skill_md)) throw new Error('proposal hit the poisoning screen');
      cand = { name: parsed.name, description: parsed.description ?? '', skill_md: parsed.skill_md };
      attempts.push({ attempt, ok: true, name: cand.name });
    } catch (e) {
      attempts.push({ attempt, ok: false, error: String(e).slice(0, 120) });
    }
  }
  const file = join(PHASES, '1-candidate.json');
  writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), promptSha, attempts, candidate: cand, ...(cand ? { candidateSha: SHA(cand.skill_md) } : {}) }, null, 2) + '\n', 'utf8');
  if (!cand) throw new Error('candidate generation failed after 3 attempts');
  console.log(`candidate: ${cand.name} (sha ${SHA(cand.skill_md).slice(0, 12)})`);
  console.log(cand.skill_md);
}

function readCandidate(): { name: string; skillMd: string; rejectedReason?: string } | null {
  const file = join(PHASES, '1-candidate.json');
  if (!existsSync(file)) return null;
  const j = JSON.parse(readFileSync(file, 'utf8')) as { candidate: { name: string; skill_md: string } | null; gateRejectedReason?: string };
  return j.candidate ? { name: j.candidate.name, skillMd: j.candidate.skill_md, rejectedReason: j.gateRejectedReason } : null;
}

async function cmdPhase2(): Promise<void> {
  const provider = glmProvider();
  const cand = readCandidate();
  if (!cand) throw new Error('run phase1 first');
  const protectBefore = protectFingerprint();
  const snapshot = loadSnapshot();
  const runner: CaseRunner = async (c, skillsPrompt) => {
    const r = await makeRunner(provider)(c, systemPromptFor(skillsPrompt));
    return r.output;
  };
  const report = await runEvolution({
    home: GATE_HOME,
    provider,
    runCase: runner,
    presetProposals: [{ name: cand.name, description: '(three-arm experiment candidate)', skill_md: cand.skillMd }],
    maxProposals: 1,
    log: (l) => console.log('  [gate]', l),
  });
  const outcome = report.outcomes.find((o) => o.name === cand.name);
  writeFileSync(join(PHASES, '2-gate.json'), JSON.stringify({ ranAt: new Date().toISOString(), outcome, full: report }, null, 2) + '\n', 'utf8');
  const cFile = join(PHASES, '1-candidate.json');
  const cj = JSON.parse(readFileSync(cFile, 'utf8')) as Record<string, unknown>;
  cj.gateOutcome = outcome?.action;
  cj.gateRejectedReason = outcome?.action === 'rejected' ? outcome?.reason : undefined;
  writeFileSync(cFile, JSON.stringify(cj, null, 2) + '\n', 'utf8');
  assertSame('phase2', protectBefore, protectFingerprint(), 'protect');
  console.log(`gate outcome: ${outcome?.action} — ${outcome?.reason}`);
}

async function cmdPhase3(): Promise<void> {
  const { tasks } = loadExperimentTasks();
  const { datasetHash } = buildTaskSetHash(tasks);
  const snapshot = loadSnapshot();
  const snapBefore = snapshotFingerprint();
  const cand = readCandidate();
  const gateOutcome = JSON.parse(readFileSync(join(PHASES, '1-candidate.json'), 'utf8')) as { gateOutcome?: string };
  const deployed = gateOutcome.gateOutcome === 'promoted' && cand ? { name: cand.name, skillMd: cand.skillMd } : undefined;
  if (!deployed) console.log('WARNING: no gate-promoted candidate — C arm will be recorded as not deployable');
  await execPhase({
    phase: '3-main', arms: ['A', 'B', 'C'], datasetHash, tasks, snapshot, candidate: deployed,
    predictFile: join(PHASES, 'predictions.jsonl'),
    outFile: join(PHASES, '3-main.jsonl'), outDir: join(PHASES, '3-outputs'),
  });
  assertSame('phase3', snapBefore, snapshotFingerprint(), 'skill snapshot');
}

function loadSnapshot(): SkillSnapshotEntry[] {
  return snapshotEntries(SNAPSHOT_DIR);
}

function assertSame(phase: string, before: string, after: string, what: string): void {
  if (before !== after) throw new Error(`${phase}: ${what} fingerprint changed (${before.slice(0, 8)} -> ${after.slice(0, 8)}) — experiment integrity violated`);
  console.log(`${phase}: ${what} integrity OK (${after.slice(0, 12)})`);
}

/* ---------------- main ---------------- */

const ALL_TASKS = new Map<string, ExperimentTask>();
{
  const { tasks } = loadExperimentTasks();
  for (const t of tasks) ALL_TASKS.set(t.id, t);
}

const cmd = process.argv[2];
if (cmd === 'setup') cmdSetup();
else if (cmd === 'phase0') await cmdPhase0();
else if (cmd === 'phase1') await cmdPhase1();
else if (cmd === 'phase2') await cmdPhase2();
else if (cmd === 'phase3') await cmdPhase3();
else {
  console.log('usage: npx tsx scripts/three-arm-experiment.mts <setup|phase0|phase1|phase2|phase3>');
  process.exit(1);
}
