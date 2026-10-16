/**
 * Long-running runtime soak (v33 pack P2 v0.29) — compressed time.
 *
 * The audit demands 2h/8h/24h checkpoint/resume stress with fault
 * injection: 状态漂移、内存、重复执行、预算耗尽. Wall-clock multi-hour runs
 * are the DEPLOYMENT form (NES not reproducible in a lab script); this
 * instrument compresses a long session into N deterministic steps (no LLM,
 * no clock) and injects the four fault classes the audit names:
 *
 *   F1 crash-restart (state drift): the live twin crashes at deterministic
 *      points and rebuilds from its last checkpoint; at every comparison
 *      point it must EQUAL the never-crashed clean twin (belief multiset,
 *      world version, calibration). Divergence = state drift across
 *      restarts.
 *   F2 duplicate execution: the naive restore replays post-checkpoint
 *      steps that the pre-crash process already applied - if double-applied
 *      evidence moves the beliefs, the runtime has an at-least-once bug.
 *      The soak runs BOTH the naive policy (expected to fail: the finding)
 *      and the cursor-guarded policy (replay starts at the checkpoint's
 *      stepsApplied cursor) - guarded must equal clean everywhere.
 *   F3 ledger corruption: junk lines interleaved into a real ledger.jsonl -
 *      the loader must skip them and keep counting (corruption never wedges
 *      the runtime).
 *   F4 budget exhaustion: referenced to the kernel valve tests (turn-valve /
 *      token-valve are unit-pinned); the soak re-verifies the stop reason
 *      is a clean valve, never a throw.
 *
 * Memory: heap and belief-count sampled throughout - growth must be bounded
 * by the model's own caps, not by step count.
 */
import { WorldModel } from '../packages/cognitive/src/world-model.ts';
import { CognitiveLedger, appendLedgerEvent, loadLedger } from '../packages/cognitive/src/ledger.ts';
import { runLoop } from '../packages/kernel/src/loop.ts';
import { Registry } from '../packages/kernel/src/registry.ts';
import { mkdtemp, rm, mkdir, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const N = Number(process.env.SOAK_STEPS ?? 2000);
const K = 100; // checkpoint interval
const TYPES = ['run_command', 'read_file', 'write_file', 'edit_file', 'list_dir', 'web_search', 'see_image', 'remember'];

function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rng = mulberry32(0x50a1);
// deterministic step stream with per-type failure rates (mixed reliability)
const RATES: Record<string, number> = { run_command: 0.82, read_file: 0.96, write_file: 0.94, edit_file: 0.83, list_dir: 0.97, web_search: 0.3, see_image: 0.98, remember: 0.99 };
const STREAM = Array.from({ length: N }, (_, i) => {
  const type = TYPES[Math.floor(rng() * TYPES.length)];
  return { i, type, outcome: rng() < RATES[type] ? ('success' as const) : ('failure' as const) };
});
// deterministic crash points (5 crashes across the run)
const CRASH_AT = new Set([377, 812, 1290, 1733, 1951].filter((x) => x < N));

function applyStep(wm: WorldModel, s: { type: string; outcome: 'success' | 'failure' }) {
  const action = { id: `s-${s.type}`, type: s.type, args: {} };
  const pred = wm.predict({ action });
  wm.update({
    stateBefore: wm.worldState,
    action,
    observation: { environmentId: 'terminal', timestamp: new Date().toISOString(), state: null, availableActions: [] },
    outcome: s.outcome,
    predictionId: pred.id,
  });
}

interface Compare { equal: boolean; where: string }
function compareModels(a: WorldModel, b: WorldModel, label: string): Compare {
  const ba = [...a.worldState.beliefs].map((x) => x.id).sort();
  const bb = [...b.worldState.beliefs].map((x) => x.id).sort();
  if (ba.length !== bb.length || ba.some((x, i) => x !== bb[i])) return { equal: false, where: `${label}: belief set differs (${ba.length} vs ${bb.length})` };
  for (let i = 0; i < ba.length; i++) {
    const ea = a.worldState.beliefs.find((x) => x.id === ba[i])!;
    const eb = b.worldState.beliefs.find((x) => x.id === bb[i])!;
    if (Math.abs(ea.confidence - eb.confidence) > 1e-9) return { equal: false, where: `${label}: belief ${ba[i]} confidence ${ea.confidence.toFixed(4)} vs ${eb.confidence.toFixed(4)}` };
  }
  if (a.worldState.version !== b.worldState.version) return { equal: false, where: `${label}: version ${a.worldState.version} vs ${b.worldState.version}` };
  return { equal: true, where: label };
}

console.log(`soak: N=${N} steps, checkpoint every ${K}, crashes at [${[...CRASH_AT].join(', ')}]`);
const heapSamples: number[] = [];

// ---------- F1/F2: crash-restart equivalence, naive vs guarded ----------
function runTwin(guarded: boolean) {
  const clean = new WorldModel('terminal');
  let live = new WorldModel('terminal');
  let cp: string | null = null;
  let cpStep = 0; // stepsApplied cursor at snapshot time
  let replayed = 0;
  const drifts: string[] = [];
  for (let i = 0; i < N; i++) {
    const s = STREAM[i];
    applyStep(clean, s);
    applyStep(live, s);
    if ((i + 1) % K === 0) { cp = live.checkpoint(); cpStep = i + 1; }
    if (CRASH_AT.has(i + 1) && cp) {
      live = WorldModel.fromCheckpoint(cp);
      const from = guarded ? cpStep : 0; // naive replays the WHOLE log from 0
      for (let j = from; j <= i; j++) { applyStep(live, STREAM[j]); replayed++; }
    }
    if ((i + 1) % 500 === 0) {
      const c = compareModels(clean, live, `step ${i + 1}`);
      if (!c.equal) drifts.push(c.where);
      heapSamples.push(process.memoryUsage().heapUsed);
    }
  }
  const finalC = compareModels(clean, live, 'final');
  if (!finalC.equal) drifts.push(finalC.where);
  return { drifts, replayed, beliefs: live.worldState.beliefs.length, cal: live.calibration() };
}

const naive = runTwin(false);
console.log(`\nF2 naive replay (no cursor): replayed=${naive.replayed} steps, drift points=${naive.drifts.length}`);
for (const d of naive.drifts.slice(0, 4)) console.log('  DRIFT: ' + d);
console.log(naive.drifts.length > 0
  ? '  -> FINDING: replaying already-applied evidence double-counts (confidence/version drift) — the at-least-once trap the audit names. The runtime MUST resume from a cursor, not from zero.'
  : '  -> unexpected: naive replay did not drift (inspect)');

const guarded = runTwin(true);
console.log(`\nF1 guarded replay (cursor): replayed=${guarded.replayed} steps, drift points=${guarded.drifts.length}`);
for (const d of guarded.drifts.slice(0, 4)) console.log('  DRIFT: ' + d);
console.log(guarded.drifts.length === 0
  ? '  -> PASS: cursor-guarded restore is bit-identical to the never-crashed twin at every checkpoint comparison'
  : '  -> FAIL: guarded replay still drifts — checkpoint cursor contract is broken');

// ---------- F3: ledger corruption at scale ----------
const home = await mkdtemp(join(tmpdir(), 'hmh-soak-'));
let ledgerOK = false;
try {
  await mkdir(join(home, 'cognitive'), { recursive: true });
  const led = new CognitiveLedger();
  const t0 = performance.now();
  let injected = 0;
  for (let i = 0; i < 2000; i++) {
    // the class builds the event (seq/shape), appendLedgerEvent persists it
    const evt = led.append('belief.revised', 'act:x', { detail: { n: i } });
    await appendLedgerEvent(home, evt);
    if (i % 97 === 0) {
      await appendFile(join(home, 'cognitive', 'ledger.jsonl'), '{CORRUPT NOT JSON\n' + (i % 191 === 0 ? '\u0000garbage\n' : ''), 'utf8');
      injected++;
    }
  }
  // the REAL corruption check: reload from the polluted file and count
  const reloaded = await loadLedger(home);
  const raw = await readFile(join(home, 'cognitive', 'ledger.jsonl'), 'utf8');
  const lines = raw.split('\n').filter(Boolean).length;
  const total = reloaded.summary().total;
  ledgerOK = total === 2000;
  console.log(`\nF3 ledger corruption: ${lines} lines on disk (${injected} injected corrupt), loadLedger total=${total}/2000, ${Math.round(performance.now() - t0)}ms`);
  console.log(ledgerOK ? '  -> PASS: corrupt lines skipped on reload, no wedge, full count preserved' : '  -> FAIL: corruption affected the count');
} finally {
  await rm(home, { recursive: true, force: true });
}

// ---------- F4: budget valve (reference re-verification) ----------
let valveClean = false;
{
  // a fake model that ALWAYS wants tools + a tiny token valve -> must stop
  // with reason 'token-valve' (clean stop), never throw
  let calls = 0;
  const chatImpl = async () => {
    calls++;
    return {
      message: { role: 'assistant' as const, content: null, tool_calls: [{ id: 'c' + calls, type: 'function' as const, function: { name: 'noop', arguments: '{}' } }] },
      usage: { prompt_tokens: 50_000, completion_tokens: 100 },
    };
  };
  const reg = new Registry();
  reg.register({ name: 'noop', description: 'x', parameters: { type: 'object', properties: {} }, async execute() { return { output: 'ok' }; } });
  try {
    const r = await runLoop({
      provider: { name: 'f', baseUrl: 'http://f', model: 'm', apiKey: 'k' } as never,
      registry: reg as never,
      messages: [{ role: 'user', content: 'go' }],
      ctx: { cwd: '.', home: '.' } as never,
      chatImpl: chatImpl as never,
      maxTotalTokens: 200_000,
      maxIdleTurns: 1000,
    });
    valveClean = r.reason === 'token-valve';
    console.log(`\nF4 budget valve: stopped after ${calls} model calls, reason=${r.reason}`);
    console.log(valveClean ? '  -> PASS: clean valve stop, no throw (unit-pinned in kernel tests; re-verified here)' : '  -> unexpected stop reason');
  } catch (e) {
    console.log('\nF4 budget valve: THREW ' + String(e).slice(0, 120));
  }
}

// ---------- memory report ----------
const heapMin = Math.min(...heapSamples), heapMax = Math.max(...heapSamples);
console.log(`\nmemory: heap samples=${heapSamples.length}, min=${Math.round(heapMin / 1e6)}MB max=${Math.round(heapMax / 1e6)}MB (growth ${Math.round((heapMax - heapMin) / 1e6)}MB over ${N} steps x2 twins)`);
console.log(`belief count at end: ${guarded.beliefs} (bounded by action-type vocabulary, not step count=${N})`);

const pass = guarded.drifts.length === 0 && ledgerOK && valveClean;
console.log(`\nSOAK VERDICT (compressed ${N} steps): ${pass ? 'PASS' : 'FAIL'} — wall-clock 2h/8h/24h daemon soak remains the deployment-form NEEDS-DATA`);
process.exit(pass ? 0 : 1);
