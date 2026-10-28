/**
 * Three-arm v2 experiment driver (expanded-sample rerun, 2026-10-28).
 *
 * Continuation of three-arm-main-experiment-2026-10-27 (NEEDS-DATA). v2:
 *   - GEPA-style candidate POPULATION (failure-class typing -> 2 candidates
 *     per class -> the WHOLE population through the same real evolution gate)
 *   - protect 23 -> 69 (hmb holdouts + HarmonyBench v1.0.0 offline cases)
 *   - seeds 3 -> 5
 *   - sanitized exports: every file copied into the evidence dir has the
 *     local username replaced by <user> BEFORE it lands on disk (publish-hook
 *     root-cause fix; the gate/main experiments run on the sanitized bytes,
 *     so what is frozen is what was run — recorded in the manifest)
 *
 * Subcommands (run in order; each is resumable):
 *   setup   - freeze the manifest: task set + datasetHash, sanitized skill
 *             snapshot, sanitized gate-home, protect dir (read-only)
 *   phase0  - null/control: arm A over train+protect, 5 seeds
 *   phase1  - failure-class typing + population generation (frozen meta-model)
 *   phase2  - the real evolution gate over the whole population
 *   phase3  - main experiment: A/B/C x (train+protect) x 5 seeds, shuffled
 *
 * Honesty rules inherited from v1: phase1 reads ONLY train-class null
 * records; the C arm runs ONLY with a gate-promoted candidate; one JSON line
 * per run on disk BEFORE any analysis runs; 429/quota death => stop at the
 * phase boundary with whatever is durable on disk (resume re-verifies).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chat } from '../packages/kernel/src/provider.ts';
import { runLoop, type LoopEvents } from '../packages/kernel/src/loop.ts';
import { Registry } from '../packages/kernel/src/registry.ts';
import { baseTools } from '../packages/agent/src/tools.ts';
import { buildSystemPrompt } from '../packages/agent/src/prompt.ts';
import type { BenchCase } from '../packages/evolution/src/bench.ts';
import { runEvolution, screenForPoison, type CaseRunner } from '../packages/evolution/src/evolve.ts';
import { HARMONYBENCH_CASES } from '../packages/evaluation/src/harmonybench.ts';
import { currentUsername, sanitizeBuffer, sanitizeTree } from '../packages/evolution/src/sanitize.ts';
import {
  FAMILY_QUOTAS, GATE_VAL_SIZE,
  selectTasks, judgeOutput, snapshotToPrompt, candidateInjection,
  buildAdaptiveBlock, familyOf,
  type ExperimentTask, type RunRecord, type SkillSnapshotEntry, type TaskLesson,
} from '../packages/evolution/src/three-arm.ts';
import {
  EXPERIMENT_ID_V2, SEEDS_V2, SHUFFLE_SEED_MATERIAL_V2, POPULATION_RULE,
  harmonyBenchToTask, harmonyBenchTaskBytes, classifyFailure,
  buildTaskSetHashV2,
  type FailureClass, type HarmonyBenchSourceCase,
} from '../packages/evolution/src/three-arm-v2.ts';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REAL_HOME = join(homedir(), '.hmharness');
const EXP = join(REPO_ROOT, 'website', 'evidence', 'experiments', 'three-arm-v2-2026-10-28');
const PHASES = join(EXP, 'phases');
const GATE_HOME = join(EXP, 'gate-home');
const PROTECT_DIR = join(EXP, 'protect');
const SNAPSHOT_DIR = join(EXP, 'skills-snapshot');
/** v1 train selection is reused verbatim (same quotas + seed) so the v2 train
 *  split is identical to v1's — comparability across the two experiments. */
const TRAIN_SELECTION_SEED = 20261027;
const SEEDS: readonly number[] = SEEDS_V2;
/** placeholder used in manifest strings for the real home path */
const SANITIZED_HOME = 'C:\\Users\\<user>\\.hmharness';

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

function loadExperimentTasks(): { tasks: ExperimentTask[]; excluded: Array<{ id: string; why: string }> } {
  const all = listCasesSync(REAL_HOME);
  const sel = selectTasks(all.map((c) => ({ id: c.name, holdout: c.holdout, tools: c.tools })), TRAIN_SELECTION_SEED);
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
  // protect expansion: HarmonyBench v1.0.0 offline-judgeable cases (46 of 54;
  // the 8 needsTools cases are excluded — unfreezable environment, same
  // rationale as v1's toolchain-* exclusions, pre-registered)
  const excluded: Array<{ id: string; why: string }> = [...sel.excluded];
  for (const c of HARMONYBENCH_CASES as unknown as HarmonyBenchSourceCase[]) {
    const t = harmonyBenchToTask(c);
    if (!t) { excluded.push({ id: `hb-${c.id}`, why: 'needsTools HarmonyBench case (unfreezable environment under the read_file/list_dir whitelist)' }); continue; }
    tasks.push(t);
  }
  return { tasks, excluded };
}

function listCasesSync(home: string): BenchCase[] {
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

/* ---------------- fingerprints ---------------- */

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

/** MUST stay byte-identical to evolution/skills.ts#parseDescription (v1
 *  lesson: divergence here voided the first phase-0 run). */
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

/* ---------------- the frozen runner ---------------- */

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
  const username = currentUsername();
  const { tasks, excluded } = loadExperimentTasks();
  const { datasetHash } = buildTaskSetHashV2(tasks);
  const train = tasks.filter((t) => t.split === 'train');
  const protect = tasks.filter((t) => t.split === 'protect');

  // sanitized skill snapshot: the real home's active library, username
  // replaced by <user> in flight (publish-hook root-cause fix; ALL arms and
  // the gate baseline run on these same sanitized bytes)
  rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
  const san = sanitizeTree(join(REAL_HOME, 'skills', 'active'), SNAPSHOT_DIR, username);
  const snapshot: SkillSnapshotEntry[] = snapshotEntries(SNAPSHOT_DIR);

  // protect dir: read-only copies (sanitized in flight; hmb files carry no
  // username in practice — the pass is a no-op safety net); HarmonyBench
  // protect tasks are written from their canonical serialized bytes
  rmSync(PROTECT_DIR, { recursive: true, force: true });
  mkdirSync(PROTECT_DIR, { recursive: true });
  for (const t of protect) {
    const bytes = t.id.startsWith('hb-')
      ? Buffer.from(harmonyBenchTaskBytes(hbSourceOf(t.id)), 'utf8')
      : sanitizeBuffer(readFileSync(join(REAL_HOME, 'bench', 'cases', `${t.id}.task`)), username);
    writeFileSync(join(PROTECT_DIR, `${t.id}.task`), bytes);
    chmodSync(join(PROTECT_DIR, `${t.id}.task`), 0o444);
  }

  // sanitized gate home: gate-train (no holdout flag) + gate-val (holdout:
  // true added); same GATE_VAL_SIZE seeded shuffle as v1
  rmSync(GATE_HOME, { recursive: true, force: true });
  mkdirSync(join(GATE_HOME, 'bench', 'cases'), { recursive: true });
  const gateVal = new Set(seededShuffle(train.map((t) => t.id), EXPERIMENT_ID_V2 + ':gate-val').slice(0, GATE_VAL_SIZE));
  const casesTmp = GATE_HOME + '-cases-tmp';
  sanitizeTree(join(REAL_HOME, 'bench', 'cases'), casesTmp, username);
  for (const t of train) {
    const raw = readFileSync(join(casesTmp, `${t.id}.task`), 'utf8');
    writeFileSync(join(GATE_HOME, 'bench', 'cases', `${t.id}.task`), gateVal.has(t.id) ? `${raw.trim()}\nholdout: true\n` : raw);
  }
  rmSync(casesTmp, { recursive: true, force: true });
  sanitizeTree(SNAPSHOT_DIR, join(GATE_HOME, 'skills', 'active'), username); // already clean; idempotent copy

  const manifest = {
    experimentId: EXPERIMENT_ID_V2,
    createdAt: new Date().toISOString(),
    repoCommit: REPO_COMMIT,
    supersedes: 'three-arm-main-experiment-2026-10-27 (NEEDS-DATA): v2 follows that report\'s single next-step recommendation (expand sample + GEPA population candidates)',
    design: {
      arms: {
        A: 'baseline: frozen (sanitized) skill-library snapshot injected, nothing else',
        B: 'task-adaptive: snapshot + per-task adaptation block built from TRAIN-family null failures, injected for this task only, never persisted',
        C: 'persistent-evolved: snapshot + the gate-promoted population winner (same injection construction as the evolution gate)',
      },
      question: 'does one persistable harness/skill change raise task success under a frozen base model without breaking the (expanded) protection set?',
    },
    frozen: {
      baseModel: { provider: 'zhipu-coding-plan', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', id: 'glm-5.3', sampling: 'no sampling params sent (provider default) — identical wire shape in all arms' },
      systemPrompt: { builder: 'packages/agent/src/prompt.ts buildSystemPrompt', params: { cwd: REPO_ROOT, memory: '', insights: '', cognitive: '', model: 'glm-5.3' }, note: 'arm differences enter ONLY via the skills block (A/B/C) and the B-arm trailing adaptation block' },
      maxTurns: MAX_TURNS,
      toolWhitelist: ['read_file', 'list_dir'],
      contextPerTask: 'fresh session per run, no history carry-over',
      seeds: SEEDS,
      taskSet: {
        train: { source: `${SANITIZED_HOME}/bench/cases`, selection: 'v1 selection verbatim (familyQuotas + seed 20261027) — v2 train split is byte-identical to v1 for comparability', familyQuotas: FAMILY_QUOTAS, selectionSeed: TRAIN_SELECTION_SEED, counts: train.length },
        protect: {
          hmbHoldout: { source: `${SANITIZED_HOME}/bench/cases (holdout:true, excluding toolchain-ohpm-status: live toolchain)`, counts: protect.filter((t) => !t.id.startsWith('hb-')).length },
          harmonybench: { source: 'packages/evaluation/src/harmonybench.ts HARMONYBENCH_CASES v1.0.0, offline-judgeable subset (needsTools=false)', counts: protect.filter((t) => t.id.startsWith('hb-')).length, excludedNeedsTools: 8 },
          total: protect.length,
          note: '>=60 requirement met (69); environment-truth judging via the same programmatic assertion judge as v1',
        },
        excluded,
        datasetHash,
        protectFiles: readdirSync(PROTECT_DIR).sort(),
      },
      skillSnapshot: {
        count: snapshot.length,
        names: snapshot.map((s) => s.name),
        fingerprint: snapshotFingerprint(),
        sanitization: `exports sanitized at copy time (username -> <user>, ${san.filesReplaced} files changed): the frozen snapshot IS the sanitized one — what ran is what is published`,
      },
      prediction: { promptTemplateSha: SHA(PREDICT_PROMPT('<task>')), note: 'same frozen model, task-only (arm-blind), parsed as first 0..1 decimal; unparseable => null (never 0)' },
      populationProposal: {
        model: 'glm-5.3 (same frozen provider)',
        rule: POPULATION_RULE,
        note: 'phase1 prompt hashes recorded in phases/1-candidates.json at generation time',
      },
    },
    preRegistered: {
      mainEndpoint: 'protect split, C-vs-A, task-level paired difference',
      significance: 'bootstrap 95% CI (task-level paired diff, 10k resamples, seeded) excludes 0 OR any per-seed exact McNemar p < 0.05',
      exploratory: ['protect B-vs-A', 'train C-vs-A', 'train B-vs-A'],
      promotionGate: { maxProtectFallback: 0.03, maxCostGrowth: 0.10, minTasksPerSplit: 15, minDiscordantCells: 8 },
      cArmRule: 'inherited from v1 verbatim + population clause: C runs ONLY with a gate-promoted candidate; if the whole population is rejected => C reported as not deployable (NEEDS-DATA on the main endpoint) — the honest outcome',
      crashRule: 'crashed runs count as task failure in the primary analysis AND are reported separately (crash rate per arm)',
      knownBehaviors: [
        'runEvolution seedCases(home) will seed 3 starter cases (toolchain-report / reply-determinism / toolchain-ohpm-status) into gate-home on first gate run — same as v1 deviation #2; symmetric for baseline and candidates, direction conservative',
        'gate-home beh-* task files are sanitized copies: their prompts reference <user> paths, so read_file cannot resolve them inside the gate — both sides of the gate fail these symmetrically (recorded; main-experiment train tasks keep original prompts and DO resolve)',
        'phase0 B-arm lessons and phase1 population input come from TRAIN-class null failures only (protect never feeds candidate generation)',
      ],
    },
    budget: {
      estimate: '~2.5-3M+ tokens across phases (505 phase0 runs, ~800 gate calls for a 10-candidate population, 1515 phase3 cells with C possibly placeholder); per-run tokens land on disk; 429 => stop at the phase boundary and wait for the quota window',
    },
    phases: ['setup', 'phase0-null', 'phase1-population', 'phase2-gate', 'phase3-main', 'phase4-analysis'],
  };
  const manifestFile = join(EXP, 'manifest.json');
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`setup done: train=${train.length} protect=${protect.length} snapshotSkills=${snapshot.length} (sanitized: ${san.filesReplaced} files changed)`);
  console.log(`datasetHash=${datasetHash}`);
  console.log(`manifestSha256=${SHA(readFileSync(manifestFile, 'utf8'))}`);
  console.log(`protectFingerprint=${protectFingerprint()}`);
  console.log('train tasks:', train.map((t) => t.id).join(', '));
  console.log('protect tasks:', protect.map((t) => t.id).join(', '));
}

/** Reverse-lookup the HarmonyBench source case for an hb-* task id. */
function hbSourceOf(id: string): HarmonyBenchSourceCase {
  const src = (HARMONYBENCH_CASES as unknown as HarmonyBenchSourceCase[]).find((c) => `hb-${c.id}` === id);
  if (!src) throw new Error(`no HarmonyBench source for ${id}`);
  return src;
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
    const cells: Array<{ task: ExperimentTask; arm: 'A' | 'B' | 'C' }> = [];
    for (const task of o.tasks) for (const arm of o.arms) cells.push({ task, arm });
    const order = seededShuffle(cells.map((c) => `${c.arm}|${c.task.id}`), SHUFFLE_SEED_MATERIAL_V2 + ':' + seed)
      .map((k) => { const [arm, id] = k.split('|'); return { task: o.tasks.find((t) => t.id === id)!, arm: arm as 'A' | 'B' | 'C' }; });

    for (const { task, arm } of order) {
      n++;
      if (done.has(`${arm}:${seed}:${task.id}`)) continue;
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

      let system: string;
      if (arm === 'A') system = systemPromptFor(snapshotToPrompt(o.snapshot));
      else if (arm === 'B') system = systemPromptFor(snapshotToPrompt(o.snapshot), buildAdaptiveBlock(task.family, lessonsFor(task.family)));
      else {
        if (!o.candidate) { appendRecord(o.outFile, crashRecord('C', o.datasetHash, seed, task, 'C-arm not deployable: gate rejected the whole candidate population', null)); continue; }
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
          experimentId: EXPERIMENT_ID_V2, repoCommit: REPO_COMMIT, datasetHash: o.datasetHash,
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
    experimentId: EXPERIMENT_ID_V2, repoCommit: REPO_COMMIT, datasetHash,
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
  const failCount = new Map<string, number>();
  for (const r of nulls) if (r.outcome.success !== true) failCount.set(r.taskId, (failCount.get(r.taskId) ?? 0) + 1);
  const ids = [...failCount.entries()].filter(([id]) => familyOf(id) === family)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map(([id]) => id);
  const out: TaskLesson[] = [];
  for (const id of ids) {
    const task = ALL_TASKS.get(id);
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
  const { datasetHash } = buildTaskSetHashV2(tasks);
  const snapshot = loadSnapshot();
  const protectBefore = protectFingerprint();
  await execPhase({
    phase: '0-null', arms: ['A'], datasetHash, tasks, snapshot,
    predictFile: join(PHASES, 'predictions.jsonl'),
    outFile: join(PHASES, '0-null.jsonl'), outDir: join(PHASES, '0-outputs'),
  });
  assertSame('phase0', protectBefore, protectFingerprint(), 'protect');
}

const CLASS_GUIDANCE: Record<FailureClass, string> = {
  'exact-output': 'These tasks demand a character-exact final reply. Teach: reply with ONLY the requested string, no preamble, no trailing punctuation, no substitutions or translations, fence the reply when the task shows a fenced/quoted target, copy the string back literally character by character.',
  format: 'These tasks demand a specific output FORMAT (regex/JSON/structure). Teach: match the requested structure exactly (braces, quotes, spacing, array shape), emit the machine-parseable form only, no prose around it.',
  'content-marker': 'These tasks fail because a required marker substring is missing. Teach: scan the task for the explicitly required keywords/markers and include each one verbatim in the reply.',
  'tool-use': 'These tasks REQUIRE reading a file with the read_file tool before answering. Teach: ALWAYS call read_file on the path the task names (before composing any answer), answer from the file content only, never guess the file content from the prompt.',
  forbidden: 'These tasks fail because a forbidden marker appears in the reply. Teach: identify the expect-none markers and strictly avoid emitting any of them; reply with the allowed content only.',
};

async function cmdPhase1(): Promise<void> {
  const provider = glmProvider();
  const nulls = loadRecords(join(PHASES, '0-null.jsonl')).filter((r) => r.holdoutClass === 'train' && r.decision === 'measured');
  if (nulls.length === 0) throw new Error('phase0 produced no train records');

  // failure typing over (task, record) — deterministic classes with their members
  const classMembers = new Map<FailureClass, Map<string, { fail: number; failSeed?: number }>>();
  for (const r of nulls) {
    const t = ALL_TASKS.get(r.taskId);
    if (!t) continue;
    const cls = classifyFailure(t, r);
    if (!cls) continue;
    const m = classMembers.get(cls) ?? new Map();
    const e = m.get(r.taskId) ?? { fail: 0 };
    e.fail++;
    e.failSeed ??= r.seed;
    m.set(r.taskId, e);
    classMembers.set(cls, m);
  }
  // class order: distinct failed tasks desc, tie by class name (pre-registered)
  const orderedClasses = [...classMembers.entries()]
    .map(([cls, m]) => ({ cls, distinct: m.size }))
    .sort((a, b) => b.distinct - a.distinct || (a.cls < b.cls ? -1 : 1))
    .slice(0, POPULATION_RULE.maxClasses);

  const classes: Array<Record<string, unknown>> = [];
  const population: Array<{ name: string; description: string; skill_md: string; failureClass: string; candidateSha: string }> = [];
  for (const { cls, distinct } of orderedClasses) {
    const members = classMembers.get(cls)!;
    const ranked = [...members.entries()].sort((a, b) => b[1].fail - a[1].fail || (a[0] < b[0] ? -1 : 1)).slice(0, 8);
    const samples = ranked.map(([id, e]) => {
      const task = ALL_TASKS.get(id)!;
      const f = join(PHASES, '0-outputs', `${e.failSeed}-A-${id}.txt`);
      const out = existsSync(f) ? readFileSync(f, 'utf8').trim().slice(0, 120) : '';
      return { task: id, prompt: task.prompt, failedOutput: out.replace(/\s+/g, ' '), fails: e.fail, ofSeeds: SEEDS.length };
    });
    const system = [
      'You are the evolution module of hmharness. The null control runs typed TRAIN failures into ONE failure class; propose skills that target exactly this class.',
      `Class guidance: ${CLASS_GUIDANCE[cls]}`,
      'Rules: each name is kebab-case; description is one line; each skill_md is at most 40 lines, terse imperatives, NO example padding, NO instruction to add explanations; it must teach doing LESS, not more. The two skills must take DIFFERENT angles.',
      'A cost gate will run: any skill that makes the agent more verbose on exact-output tasks is auto-rejected even if correctness improves.',
      'Respond with ONLY a JSON array of exactly 2 items: [{"name":"...","description":"...","skill_md":"..."}]',
    ].join('\n');
    const user = `Failure class: ${cls} (${distinct} distinct failed tasks)\nFailed-task digest from the null control (${SEEDS.length} seeds each):\n${JSON.stringify(samples, null, 1)}\n\nPropose exactly 2 complementary skills for this failure class.`;
    const promptSha = SHA(system + '\n||\n' + user);

    const cands: Array<Record<string, unknown>> = [];
    for (let attempt = 1; attempt <= 3 && cands.length < POPULATION_RULE.perClassCandidates; attempt++) {
      const r = await chat(provider, [
        { role: 'system', content: system },
        { role: 'user', content: user + (attempt > 1 ? `\n\n(Previous attempt for this class was unusable. Try again with simpler, terser skills.)` : '') },
      ]);
      const raw = (r.message.content ?? '').replace(/```(?:json)?/g, '');
      const start = raw.indexOf('[');
      try {
        const parsed = JSON.parse(raw.slice(start, raw.lastIndexOf(']') + 1)) as Array<{ name: string; description?: string; skill_md: string }>;
        for (const p of parsed) {
          if (cands.length >= POPULATION_RULE.perClassCandidates) break;
          if (!/^[a-z0-9-]+$/.test(p.name ?? '') || !p.skill_md) throw new Error('malformed proposal');
          if (screenForPoison(p.skill_md)) throw new Error('proposal hit the poisoning screen');
          cands.push({ attempt, ok: true, name: p.name });
          population.push({ name: p.name, description: p.description ?? '', skill_md: p.skill_md, failureClass: cls, candidateSha: SHA(p.skill_md) });
        }
      } catch (e) {
        cands.push({ attempt, ok: false, error: String(e).slice(0, 120) });
      }
    }
    classes.push({ class: cls, distinctFailedTasks: distinct, promptSha, samples: samples.map((s) => s.task), candidates: cands });
    console.log(`class ${cls}: ${distinct} failed tasks -> ${population.filter((p) => p.failureClass === cls).length} candidates`);
  }

  writeFileSync(join(PHASES, '1-candidates.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    rule: POPULATION_RULE,
    classes, population,
  }, null, 2) + '\n', 'utf8');
  console.log(`population: ${population.length} candidates -> ${population.map((p) => `${p.name}(${p.failureClass})`).join(', ')}`);
  if (population.length === 0) throw new Error('population generation produced zero candidates');
}

interface CandidatesFile {
  generatedAt: string;
  population: Array<{ name: string; description: string; skill_md: string; failureClass: string; candidateSha: string }>;
  gateOutcome?: { ranAt: string; promoted: string[]; rejected: string[]; deployedChoice?: { name: string; rule: string } };
}

function readCandidates(): CandidatesFile {
  return JSON.parse(readFileSync(join(PHASES, '1-candidates.json'), 'utf8')) as CandidatesFile;
}

async function cmdPhase2(): Promise<void> {
  const provider = glmProvider();
  const cands = readCandidates();
  if (cands.population.length === 0) throw new Error('run phase1 first');
  const protectBefore = protectFingerprint();
  const runner: CaseRunner = async (c, skillsPrompt) => {
    const r = await makeRunner(provider)(c, systemPromptFor(skillsPrompt));
    return r.output;
  };
  const report = await runEvolution({
    home: GATE_HOME,
    provider,
    runCase: runner,
    presetProposals: cands.population.map((p) => ({ name: p.name, description: `(three-arm-v2 population candidate, class ${p.failureClass})`, skill_md: p.skill_md })),
    maxProposals: cands.population.length,
    log: (l) => console.log('  [gate]', l),
  });
  writeFileSync(join(PHASES, '2-gate.json'), JSON.stringify({ ranAt: new Date().toISOString(), report }, null, 2) + '\n', 'utf8');

  // pre-registered pick: highest gate train pass rate among promoted; tie -> lexicographically smallest name
  const promoted = report.outcomes.filter((o) => o.action === 'promoted');
  let deployedChoice: { name: string; rule: string } | undefined;
  if (promoted.length > 0) {
    const best = [...promoted].sort((a, b) =>
      (b.candidate?.passRate ?? 0) - (a.candidate?.passRate ?? 0) || (a.name < b.name ? -1 : 1))[0]!;
    deployedChoice = { name: best.name, rule: POPULATION_RULE.cArmPick };
  }
  const cf = readCandidates();
  cf.gateOutcome = {
    ranAt: new Date().toISOString(),
    promoted: promoted.map((o) => o.name),
    rejected: report.outcomes.filter((o) => o.action === 'rejected').map((o) => o.name),
    ...(deployedChoice ? { deployedChoice } : {}),
  };
  writeFileSync(join(PHASES, '1-candidates.json'), JSON.stringify(cf, null, 2) + '\n', 'utf8');
  assertSame('phase2', protectBefore, protectFingerprint(), 'protect');
  console.log(`gate outcome: promoted=[${promoted.map((o) => o.name).join(', ') || 'none'}] deployed=${deployedChoice?.name ?? 'NONE (C arm not deployable)'}`);
}

async function cmdPhase3(): Promise<void> {
  const { tasks } = loadExperimentTasks();
  const { datasetHash } = buildTaskSetHashV2(tasks);
  const snapshot = loadSnapshot();
  const snapBefore = snapshotFingerprint();
  const cands = readCandidates();
  const winnerName = cands.gateOutcome?.deployedChoice?.name;
  const winner = winnerName ? cands.population.find((p) => p.name === winnerName) : undefined;
  const deployed = winner ? { name: winner.name, skillMd: winner.skill_md } : undefined;
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
  console.log('usage: npx tsx scripts/three-arm-v2-experiment.mts <setup|phase0|phase1|phase2|phase3>');
  process.exit(1);
}
