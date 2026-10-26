/**
 * Prediction-to-Action v3 — LIVE intervention (v33 pack P1 v0.24 flagship).
 *
 * v2 (p2a-task-outcomes.mts) showed the learned WM discriminates doomed
 * steps (43-50% precision) while trajectory-level correlation was NEGATIVE —
 * but v2 was observational: nobody changed behavior. This instrument
 * actually INTERVENES. The kernel's new toolGate hook (loop.ts, 2026-10-15)
 * lets a learned world model refuse an action BEFORE it executes; the
 * refusal reason becomes the tool result so the model re-plans.
 *
 *   Arm A (baseline): no gate.
 *   Arm B (gated):    learned-WM gate — refuse when
 *                     wm.predict({action}).confidence < tau.
 *
 * Paired design: the SAME tasks run in BOTH arms, each in a FRESH temp
 * workspace, same provider/model, same approval policy (always-grant — the
 * gate is the only variable). Task success is judged by EXTERNAL
 * deterministic verifiers on the workspace state, never the model's
 * self-report. Preregistered metrics: primary = task success; secondary =
 * turns, tool calls, gate refusals, token usage. Results are reported
 * honestly whatever they are — a negative is a finding (v33 audit: 无足够
 * 证据就标 NEEDS-DATA，不能营销成已证明能力).
 */
import { runLoop } from '../packages/kernel/src/loop.ts';
import { Registry } from '../packages/kernel/src/registry.ts';
import { nativeRegistry } from '../packages/agent/src/runner.ts';
import {
  loadTrajectories,
  replayIntoWorldModel,
} from '../packages/cognitive/src/index.ts';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { seededShuffle } from '../packages/evaluation/src/research-repro.ts';

const HOME = process.env.HMH_HOME ?? join(homedir(), '.hmharness');
const TAU = Number(process.env.P2A_TAU ?? 0.5);
const SEED = Number(process.env.P2A_SEED ?? 1);
const MAX_TURNS = Number(process.env.P2A_MAX_TURNS ?? 24);

// ---- 1. train the world model on the terminal corpus (train split) ----
function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hashSeed(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

const all = await loadTrajectories(HOME, 1000);
const usable = all.filter((t) => t.steps.length > 0 && t.environment.id === 'terminal');
if (usable.length < 40) { console.error(`NEEDS-DATA: only ${usable.length} terminal trajectories with steps — train the corpus first`); process.exit(1); }
const rng = mulberry32(hashSeed('p2a-intervention-' + SEED));
const shuffled = seededShuffle(usable, rng);
const train = shuffled.slice(0, Math.floor(shuffled.length * 0.7));
// second arg is the ENVIRONMENT ID (replay filters on it) - passing a path
// here silently replays NOTHING (bit us once: an empty WM blanket-refused)
const wm = replayIntoWorldModel(train, 'terminal');
console.log(`world model trained on ${train.length}/${usable.length} terminal trajectories (seed ${SEED}), tau=${TAU}`);

// gate policy: consult the WM for every tool call.
// - query the way predict() keys: action.type (a bare string keys to
//   'undefined' and looks like a blanket-failure prophecy)
// - knownUnknown (no evidence) is an EXPLORE signal per the WM contract,
//   not 0% success: unknown actions pass through
function gateFor(name: string, args: Record<string, unknown>) {
  void args;
  const p = wm.predict({ action: { type: name } });
  const unknown = p.claim.startsWith('no evidence');
  if (!unknown && p.confidence < TAU) {
    return {
      allowed: false as const,
      reason: `the learned world model predicts this action type (${name}) tends to fail in similar contexts (confidence ${p.confidence.toFixed(2)} < ${TAU}); choose a different approach or verify prerequisites first`,
    };
  }
  return { allowed: true as const };
}

// ---- 1b. context-conditioned gate (v0.24 follow-up): sequence depth-1 ----
// The corpus probe (p2a-context-probe.mts) found pairs whose success rate
// diverges from the type baseline (read_file->edit_file 0.56 vs 0.83). This
// gate uses RAW rates with an honesty backoff: a pair or type below
// MIN_SUPPORT carries no verdict (falls through to the coarser level; at
// the coarsest level no-evidence = allow). The pair verdict overrides the
// type verdict in BOTH directions (worse pair blocks where the type passes;
// better pair passes where the type blocks).
const MIN_SUPPORT = Number(process.env.P2A_MIN_SUPPORT ?? 10);
const typeStat = new Map<string, { s: number; f: number }>();
const pairStat = new Map<string, { s: number; f: number }>();
{
  const bump = (m: Map<string, { s: number; f: number }>, k: string, ok: boolean) => {
    const e = m.get(k) ?? { s: 0, f: 0 };
    if (ok) e.s++; else e.f++;
    m.set(k, e);
  };
  for (const t of train) {
    let prev: string | null = null;
    for (const s of t.steps) {
      const type = String((s.action as { type?: unknown }).type ?? '?');
      if (s.outcome === 'success' || s.outcome === 'failure') {
        bump(typeStat, type, s.outcome === 'success');
        if (prev !== null) bump(pairStat, `${prev}->${type}`, s.outcome === 'success');
      }
      prev = type;
    }
  }
}
function conditionedGateFactory() {
  let lastType: string | null = null; // last ALLOWED action type (executions, not refusals, change the world)
  return (name: string): { allowed: true } | { allowed: false; reason: string } => {
    const pair = lastType !== null ? pairStat.get(`${lastType}->${name}`) : undefined;
    const pairN = pair ? pair.s + pair.f : 0;
    const type = typeStat.get(name);
    const typeN = type ? type.s + type.f : 0;
    let v: { allowed: true } | { allowed: false; reason: string };
    if (pairN >= MIN_SUPPORT) {
      const pr = pair!.s / pairN;
      v = pr < TAU
        ? { allowed: false, reason: `the learned world model predicts ${lastType}->${name} fails often in similar contexts (pair success ${pr.toFixed(2)} < ${TAU}, ${pairN} observations); choose a different approach or verify prerequisites first` }
        : { allowed: true };
    } else if (typeN >= MIN_SUPPORT) {
      const tr = type!.s / typeN;
      v = tr < TAU
        ? { allowed: false, reason: `the learned world model predicts this action type (${name}) tends to fail (success ${tr.toFixed(2)} < ${TAU}, ${typeN} observations); choose a different approach or verify prerequisites first` }
        : { allowed: true };
    } else {
      v = { allowed: true }; // no evidence = explore signal, not 0% success
    }
    if (v.allowed) lastType = name;
    return v;
  };
}

// ---- 2. task suite: deterministic prompts + EXTERNAL verifiers ----
interface Task {
  id: string;
  prompt: string;
  verify: (ws: string) => { ok: boolean; detail: string };
  /** optional workspace seeding (modify-suite: the file to edit pre-exists) */
  setup?: (ws: string) => Promise<void>;
}
const eq = (a: string, b: string) => a.replace(/\r\n/g, '\n').trim() === b.trim();
const TASKS: Task[] = [
  {
    id: 'notes-3lines',
    prompt: 'Create a file named notes.txt in the current directory containing exactly three lines: alpha, beta, gamma (one word per line, nothing else).',
    verify: (ws) => {
      const p = join(ws, 'notes.txt');
      if (!existsSync(p)) return { ok: false, detail: 'notes.txt missing' };
      const ok = eq(readFileSync(p, 'utf8'), 'alpha\nbeta\ngamma');
      return { ok, detail: ok ? 'exact content' : 'content mismatch: ' + JSON.stringify(readFileSync(p, 'utf8').slice(0, 60)) };
    },
  },
  {
    id: 'config-json',
    prompt: 'Create config.json in the current directory with exactly this structure: {"name":"p2a","version":2,"tags":["a","b"]}. Valid JSON, no extra keys.',
    verify: (ws) => {
      const p = join(ws, 'config.json');
      if (!existsSync(p)) return { ok: false, detail: 'config.json missing' };
      try {
        const j = JSON.parse(readFileSync(p, 'utf8'));
        const ok = j.name === 'p2a' && j.version === 2 && Array.isArray(j.tags) && j.tags.join() === 'a,b';
        return { ok, detail: ok ? 'structure matches' : 'wrong structure: ' + JSON.stringify(j).slice(0, 60) };
      } catch (e) { return { ok: false, detail: 'invalid JSON: ' + String(e).slice(0, 60) }; }
    },
  },
  {
    id: 'two-files',
    prompt: 'Create src/a.txt containing the single word A, and src/b.txt containing the single word B (create the src directory as needed).',
    verify: (ws) => {
      const a = existsSync(join(ws, 'src', 'a.txt')) && eq(readFileSync(join(ws, 'src', 'a.txt'), 'utf8'), 'A');
      const b = existsSync(join(ws, 'src', 'b.txt')) && eq(readFileSync(join(ws, 'src', 'b.txt'), 'utf8'), 'B');
      return { ok: a && b, detail: `a=${a} b=${b}` };
    },
  },
  {
    id: 'word-count',
    prompt: 'Create input.txt containing the text: one two three. Then create count.txt containing just the number of words in input.txt (i.e. 3).',
    verify: (ws) => {
      const okIn = existsSync(join(ws, 'input.txt'));
      const okCount = existsSync(join(ws, 'count.txt')) && eq(readFileSync(join(ws, 'count.txt'), 'utf8'), '3');
      return { ok: okIn && okCount, detail: `input=${okIn} count=${okCount}` };
    },
  },
  {
    id: 'copy-content',
    prompt: 'Create base.txt containing the word root. Then create copy.txt with the exact same content as base.txt.',
    verify: (ws) => {
      const ok = existsSync(join(ws, 'base.txt')) && existsSync(join(ws, 'copy.txt'))
        && eq(readFileSync(join(ws, 'base.txt'), 'utf8'), readFileSync(join(ws, 'copy.txt'), 'utf8'));
      return { ok, detail: ok ? 'contents equal' : 'missing or unequal' };
    },
  },
  {
    id: 'listing',
    prompt: 'Create two files x.txt and y.txt with any content, then create listing.txt containing a listing of the current directory (the filenames must appear in it).',
    verify: (ws) => {
      const l = join(ws, 'listing.txt');
      if (!existsSync(l)) return { ok: false, detail: 'listing.txt missing' };
      const c = readFileSync(l, 'utf8');
      const ok = existsSync(join(ws, 'x.txt')) && existsSync(join(ws, 'y.txt')) && /x\.txt/.test(c) && /y\.txt/.test(c);
      return { ok, detail: ok ? 'both listed' : 'listing incomplete' };
    },
  },
];

// modify-suite (P2A_SUITE=modify): tasks that REQUIRE touching an EXISTING
// file — the regime where the corpus's one strongly divergent pair
// (read_file->edit_file 0.56 vs 0.83) actually occurs. Create-from-scratch
// tasks never hit it (the model just write_file's), which is why the
// create-suite at tau=.7 produced zero gate consults.
const MODIFY_TASKS: Task[] = [
  {
    id: 'edit-existing',
    prompt: 'The file app.txt in the current directory contains the text v1. Change its content to v2 (exactly v2, nothing else).',
    setup: async (ws) => { await import('node:fs/promises').then((f) => f.writeFile(join(ws, 'app.txt'), 'v1\n', 'utf8')); },
    verify: (ws) => {
      const p = join(ws, 'app.txt');
      if (!existsSync(p)) return { ok: false, detail: 'app.txt missing' };
      const ok = eq(readFileSync(p, 'utf8'), 'v2');
      return { ok, detail: ok ? 'edited to v2' : 'content: ' + JSON.stringify(readFileSync(p, 'utf8').slice(0, 30)) };
    },
  },
  {
    id: 'append-line',
    prompt: 'The file log.txt contains two lines: a and b. Append a third line c (keep a and b intact).',
    setup: async (ws) => { await import('node:fs/promises').then((f) => f.writeFile(join(ws, 'log.txt'), 'a\nb\n', 'utf8')); },
    verify: (ws) => {
      const p = join(ws, 'log.txt');
      if (!existsSync(p)) return { ok: false, detail: 'log.txt missing' };
      const ok = eq(readFileSync(p, 'utf8'), 'a\nb\nc');
      return { ok, detail: ok ? 'appended' : 'content: ' + JSON.stringify(readFileSync(p, 'utf8').slice(0, 30)) };
    },
  },
  {
    id: 'fix-json',
    prompt: 'The file data.json contains {"n":1}. Change n to 2, keeping valid JSON and no other changes.',
    setup: async (ws) => { await import('node:fs/promises').then((f) => f.writeFile(join(ws, 'data.json'), '{"n":1}\n', 'utf8')); },
    verify: (ws) => {
      const p = join(ws, 'data.json');
      if (!existsSync(p)) return { ok: false, detail: 'data.json missing' };
      try {
        const j = JSON.parse(readFileSync(p, 'utf8'));
        const ok = j.n === 2 && Object.keys(j).length === 1;
        return { ok, detail: ok ? 'n=2' : 'wrong: ' + JSON.stringify(j).slice(0, 40) };
      } catch { return { ok: false, detail: 'invalid JSON' }; }
    },
  },
];
const SUITE = process.env.P2A_SUITE ?? 'create';
// hard-suite (P2A_SUITE=hard): tasks that reproduce the corpus's REAL edit
// failure modes — precise navigation in a large file, cross-file
// consistency, deep JSON surgery, disambiguation among similar lines.
// Simple modify tasks never fail (any model, clean workspace), so a
// protective gate has nothing to protect; these give it failure
// opportunities the corpus actually contains.
const bigLines = (i: number) => `line ${i + 1}: ${i % 7 === 0 ? 'alpha' : 'beta'}`;
const itemsLine = (n: number) => `id=${n} name=${n === 7 ? 'seventh' : 'item' + n} status=${n === 5 ? 'pending' : 'active'}`;
const HARD_TASKS: Task[] = [
  {
    id: 'big-file-edit',
    prompt: 'The file big.txt has 200 numbered lines. Change ONLY line 140 so it says "line 140: gamma" instead of its current content. Every other line must stay exactly as it is, and the file must still have exactly 200 lines.',
    setup: async (ws) => {
      const f = await import('node:fs/promises');
      await f.writeFile(join(ws, 'big.txt'), Array.from({ length: 200 }, (_, i) => bigLines(i)).join('\n') + '\n', 'utf8');
    },
    verify: (ws) => {
      const p = join(ws, 'big.txt');
      if (!existsSync(p)) return { ok: false, detail: 'big.txt missing' };
      const lines = readFileSync(p, 'utf8').replace(/\r\n/g, '\n').split('\n').filter((l, i, a) => i < a.length - 1 || l !== '');
      if (lines.length !== 200) return { ok: false, detail: `line count ${lines.length} != 200` };
      for (let i = 0; i < 200; i++) {
        const want = i === 139 ? 'line 140: gamma' : bigLines(i);
        if (lines[i] !== want) return { ok: false, detail: `line ${i + 1} wrong: ${JSON.stringify(lines[i])}` };
      }
      return { ok: true, detail: 'exact 200-line edit' };
    },
  },
  {
    id: 'two-file-version',
    prompt: 'The current directory has package.json and about.txt, both carrying version 1.0.0. Bump the version to 2.0.0 in BOTH files (package.json must stay valid JSON; about.txt is plain text mentioning the version).',
    setup: async (ws) => {
      const f = await import('node:fs/promises');
      await f.writeFile(join(ws, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }, null, 2) + '\n', 'utf8');
      await f.writeFile(join(ws, 'about.txt'), 'App version 1.0.0\nReleased 2026\n', 'utf8');
    },
    verify: (ws) => {
      try {
        const j = JSON.parse(readFileSync(join(ws, 'package.json'), 'utf8'));
        if (j.version !== '2.0.0' || j.name !== 'app') return { ok: false, detail: 'package.json wrong: ' + JSON.stringify(j).slice(0, 50) };
      } catch (e) { return { ok: false, detail: 'package.json invalid: ' + String(e).slice(0, 40) }; }
      const t = readFileSync(join(ws, 'about.txt'), 'utf8');
      const ok = t.includes('2.0.0') && !t.includes('1.0.0') && t.includes('Released 2026');
      return { ok, detail: ok ? 'both bumped' : 'about.txt: ' + JSON.stringify(t.slice(0, 50)) };
    },
  },
  {
    id: 'nested-json',
    prompt: 'In data.json, change ONLY the value at path a.b.c.d from 1 to 2. Keep everything else identical and the file valid JSON (a.b.c.e, a.b.f, and the array g must be untouched).',
    setup: async (ws) => {
      const f = await import('node:fs/promises');
      await f.writeFile(join(ws, 'data.json'), JSON.stringify({ a: { b: { c: { d: 1, e: 2 }, f: 3 } }, g: [1, 2, 3] }, null, 2) + '\n', 'utf8');
    },
    verify: (ws) => {
      try {
        const j = JSON.parse(readFileSync(join(ws, 'data.json'), 'utf8')) as { a?: { b?: { c?: { d?: unknown; e?: unknown }, f?: unknown } }, g?: unknown };
        const ok = j.a?.b?.c?.d === 2 && j.a?.b?.c?.e === 2 && j.a?.b?.f === 3 && JSON.stringify(j.g) === '[1,2,3]';
        return { ok, detail: ok ? 'surgical edit' : 'wrong: ' + JSON.stringify(j).slice(0, 60) };
      } catch { return { ok: false, detail: 'invalid JSON' }; }
    },
  },
  {
    id: 'similar-lines',
    prompt: 'The file items.txt has 12 entries, one per line, each shaped like "id=N name=... status=...". Change the status of the entry with id=7 from active to archived. Do not touch any other entry (note: id=5 has status=pending — leave that alone).',
    setup: async (ws) => {
      const f = await import('node:fs/promises');
      await f.writeFile(join(ws, 'items.txt'), Array.from({ length: 12 }, (_, i) => itemsLine(i + 1)).join('\n') + '\n', 'utf8');
    },
    verify: (ws) => {
      const p = join(ws, 'items.txt');
      if (!existsSync(p)) return { ok: false, detail: 'items.txt missing' };
      const lines = readFileSync(p, 'utf8').replace(/\r\n/g, '\n').split('\n').filter((l, i, a) => i < a.length - 1 || l !== '');
      if (lines.length !== 12) return { ok: false, detail: `line count ${lines.length} != 12` };
      for (let i = 0; i < 12; i++) {
        const want = i === 6 ? 'id=7 name=seventh status=archived' : itemsLine(i + 1);
        if (lines[i] !== want) return { ok: false, detail: `line ${i + 1} wrong: ${JSON.stringify(lines[i])}` };
      }
      return { ok: true, detail: 'disambiguated edit' };
    },
  },
];
const ACTIVE = SUITE === 'modify' ? MODIFY_TASKS : SUITE === 'hard' ? HARD_TASKS : TASKS;
console.log(`suite=${SUITE} (${ACTIVE.length} tasks)`);

// ---- 3. provider (production chat route by default; P2A_PROVIDER switches
// the population — the weak-model arm is where corpus read->edit failures
// actually came from, so that is where a protective gate could show
// task-level gains the strong population cannot) ----
const PROV_ID = process.env.P2A_PROVIDER ?? 'glm';
const cfg = JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8')) as {
  providers: Record<string, { baseUrl: string; apiKey: string; model: string }>;
};
const glm = cfg.providers[PROV_ID];
if (!glm?.apiKey) { console.error(`provider ${PROV_ID} not configured`); process.exit(1); }
console.log(`provider: ${PROV_ID} (${glm.model})`);
const provider = { name: PROV_ID, baseUrl: glm.baseUrl, apiKey: glm.apiKey, model: glm.model } as never;

// ---- 4. run the paired experiment ----
interface RunResult {
  task: string; arm: 'A' | 'B' | 'C'; ok: boolean; detail: string;
  turns: number; toolUses: number; refusals: number;
  promptTokens: number; completionTokens: number; reason: string;
}
const results: RunResult[] = [];
// A = no gate; B = type-granularity gate (WM EMA confidence); C = sequence-
// conditioned gate (raw pair/type rates, honest backoff). C answers whether
// context conditioning adds selectivity where B is inert.
const ARMS: Array<{ id: 'A' | 'B' | 'C'; gate: null | 'type' | 'conditioned' }> = [
  { id: 'A', gate: null },
  { id: 'B', gate: 'type' },
  { id: 'C', gate: 'conditioned' },
];
let wsCounter = 0;
for (const task of ACTIVE) {
  for (const arm of ARMS) {
    const ws = join(tmpdir(), `p2a-live-${Date.now()}-${wsCounter++}`);
    mkdirSync(ws, { recursive: true });
    const home2 = join(ws, '_home'); mkdirSync(home2, { recursive: true });
    if (task.setup) await task.setup(ws);
    let refusals = 0;
    let gateChecks = 0;
    // a FRESH conditioned-gate sequence state per run (pair context resets with the workspace)
    const conditioned = conditionedGateFactory();
    try {
      const reg: Registry = nativeRegistry(0);
      const r = await runLoop({
        provider,
        registry: reg as never,
        messages: [{ role: 'user', content: task.prompt }],
        ctx: { cwd: ws, home: home2 } as never,
        maxTotalTurns: MAX_TURNS,
        approval: { ask: async () => true },
        toolGate: arm.gate
          ? { check: async (name, args) => {
              gateChecks++;
              const v = arm.gate === 'conditioned'
                ? conditioned(name)
                : gateFor(name, args);
              if (!v.allowed) refusals++;
              return v;
            } }
          : undefined,
      });
      const v = task.verify(ws);
      results.push({
        task: task.id, arm: arm.id, ok: v.ok, detail: v.detail,
        turns: r.turns, toolUses: r.toolUses, refusals,
        promptTokens: r.usage.promptTokens, completionTokens: r.usage.completionTokens,
        reason: r.reason,
      });
      console.log(`  ${arm.id} ${task.id}: ${v.ok ? 'PASS' : 'FAIL'} (${v.detail}) turns=${r.turns} tools=${r.toolUses} refused=${refusals} tok=${r.usage.promptTokens + r.usage.completionTokens} [${r.reason}]`);
    } catch (e) {
      results.push({ task: task.id, arm: arm.id, ok: false, detail: 'run error: ' + String(e).slice(0, 80), turns: 0, toolUses: 0, refusals, promptTokens: 0, completionTokens: 0, reason: 'error' });
      console.log(`  ${arm.id} ${task.id}: RUN-ERROR ${String(e).slice(0, 80)}`);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }
}

// ---- 5. paired report (preregistered: primary = task success) ----
console.log('\n=== P2A v3 LIVE intervention — paired results ===');
const n = ACTIVE.length;
const LABEL: Record<'A' | 'B' | 'C', string> = { A: 'no gate', B: 'type gate (WM EMA)', C: 'conditioned gate (pair/type)' };
for (const armId of ['A', 'B', 'C'] as const) {
  const rs = results.filter((r) => r.arm === armId);
  const succ = rs.filter((r) => r.ok).length;
  const turns = rs.reduce((x, r) => x + r.turns, 0);
  const ref = rs.reduce((x, r) => x + r.refusals, 0);
  const tok = rs.reduce((x, r) => x + r.promptTokens + r.completionTokens, 0);
  console.log(`arm ${armId} (${LABEL[armId]}): ${succ}/${n} tasks, turns=${turns}, refused=${ref}, tokens=${tok}`);
}
for (const gated of ['B', 'C'] as const) {
  let better = 0, worse = 0, ties = 0;
  for (const task of ACTIVE) {
    const a = results.find((r) => r.task === task.id && r.arm === 'A');
    const g = results.find((r) => r.task === task.id && r.arm === gated);
    if (!a || !g) continue;
    if (a.ok !== g.ok) { g.ok ? better++ : worse++; } else ties++;
  }
  console.log(`paired A vs ${gated}: ${gated} better=${better}, worse=${worse}, ties=${ties}`);
  if (worse > 0 && better === 0) console.log(`  VERDICT ${gated}: gating HURT at tau=${TAU} — honest negative.`);
  else if (better > 0 && worse === 0) console.log(`  VERDICT ${gated}: gating HELPED every divergent pair at tau=${TAU}.`);
  else if (better === 0 && worse === 0) console.log(`  VERDICT ${gated}: no divergence on this suite at tau=${TAU} — NEEDS-DATA.`);
  else console.log(`  VERDICT ${gated}: mixed (${better} better / ${worse} worse) — extend tasks/seeds before any claim.`);
}

// raw per-run lines for the research repro pack
console.log('\nraw:');
for (const r of results) {
  console.log(JSON.stringify(r));
}
