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
const shuffled = [...usable].sort(() => rng() - 0.5);
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

// ---- 2. task suite: deterministic prompts + EXTERNAL verifiers ----
interface Task {
  id: string;
  prompt: string;
  verify: (ws: string) => { ok: boolean; detail: string };
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

// ---- 3. provider (production chat route, glm) ----
const cfg = JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8')) as {
  providers: Record<string, { baseUrl: string; apiKey: string; model: string }>;
};
const glm = cfg.providers['glm'];
if (!glm?.apiKey) { console.error('provider glm not configured'); process.exit(1); }
const provider = { name: 'glm', baseUrl: glm.baseUrl, apiKey: glm.apiKey, model: glm.model } as never;

// ---- 4. run the paired experiment ----
interface RunResult {
  task: string; arm: 'A' | 'B'; ok: boolean; detail: string;
  turns: number; toolUses: number; refusals: number;
  promptTokens: number; completionTokens: number; reason: string;
}
const results: RunResult[] = [];
const ARMS: Array<{ id: 'A' | 'B'; gate: boolean }> = [{ id: 'A', gate: false }, { id: 'B', gate: true }];
let wsCounter = 0;
for (const task of TASKS) {
  for (const arm of ARMS) {
    const ws = join(tmpdir(), `p2a-live-${Date.now()}-${wsCounter++}`);
    mkdirSync(ws, { recursive: true });
    const home2 = join(ws, '_home'); mkdirSync(home2, { recursive: true });
    let refusals = 0;
    let gateChecks = 0;
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
          ? { check: async (name, args) => { gateChecks++; const v = gateFor(name, args); if (!v.allowed) refusals++; return v; } }
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
const aSucc = results.filter((r) => r.arm === 'A' && r.ok).length;
const bSucc = results.filter((r) => r.arm === 'B' && r.ok).length;
const aRef = results.filter((r) => r.arm === 'A').reduce((n, r) => n + r.refusals, 0);
const bRef = results.filter((r) => r.arm === 'B').reduce((n, r) => n + r.refusals, 0);
const aTok = results.filter((r) => r.arm === 'A').reduce((n, r) => n + r.promptTokens + r.completionTokens, 0);
const bTok = results.filter((r) => r.arm === 'B').reduce((n, r) => n + r.promptTokens + r.completionTokens, 0);
const aTurns = results.filter((r) => r.arm === 'A').reduce((n, r) => n + r.turns, 0);
const bTurns = results.filter((r) => r.arm === 'B').reduce((n, r) => n + r.turns, 0);
const n = TASKS.length;
console.log(`arm A (no gate):      ${aSucc}/${n} tasks, turns=${aTurns}, refused=${aRef}, tokens=${aTok}`);
console.log(`arm B (learned gate): ${bSucc}/${n} tasks, turns=${bTurns}, refused=${bRef}, tokens=${bTok}`);
// paired sign on the primary metric
let bBetter = 0, bWorse = 0, ties = 0;
for (const task of TASKS) {
  const a = results.find((r) => r.task === task.id && r.arm === 'A');
  const b = results.find((r) => r.task === task.id && r.arm === 'B');
  if (!a || !b) continue;
  if (a.ok !== b.ok) { b.ok ? bBetter++ : bWorse++; } else ties++;
}
console.log(`paired primary (success): B better=${bBetter}, B worse=${bWorse}, ties=${ties}`);
console.log(`gate consulted ${(() => { let x = 0; results.forEach((r) => { if (r.arm === 'B') x += r.refusals; }); return x; })()} refusal(s) at tau=${TAU}`);
if (bWorse > 0 && bBetter === 0) console.log('VERDICT: live gating HURT task outcomes at this tau — the gate is too blunt at action-type granularity; report honestly (v0.24 finding).');
else if (bBetter > 0 && bWorse === 0) console.log('VERDICT: live gating HELPED every divergent pair — first interventional evidence that learned predictions change task outcomes.');
else if (bBetter === 0 && bWorse === 0) console.log('VERDICT: no divergence on these tasks (both arms equal) — NEEDS-DATA: harder task set or lower tau.');
else console.log(`VERDICT: mixed (${bBetter} better / ${bWorse} worse) — extend task set and seeds before any claim.`);

// raw per-run lines for the research repro pack
console.log('\nraw:');
for (const r of results) {
  console.log(JSON.stringify(r));
}
