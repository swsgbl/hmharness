/**
 * Wall-clock daemon soak (v0.29 deployment-form, 2h tier; rewritten
 * 2026-10-20 after a lost run: the result file is now written BEFORE any
 * exit, stdout heartbeats every 10 polls, no process.exit() — the process
 * ends naturally so nothing is truncated).
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOURS = Number(process.env.SOAK_HOURS ?? 2);
const INTERVAL_MS = 60_000;
const RESULT = 'G:/hmharness/.audit/wallclock-soak-result.json';
const home = await mkdtemp(join(tmpdir(), 'hmh-wallclock-'));
await mkdir(join(home, 'sessions'), { recursive: true });
process.env.HMH_HOME = home;

const { startServer } = await import(pathToFileURL('G:/hmharness/packages/web/src/server.ts').href);
const handle = await startServer({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${handle.port}`;
const t0 = Date.now();
console.log(`wall-clock soak: ${HOURS}h @ ${base}`);

let polls = 0, stateOk = 0, cogOk = 0, errors5xx = 0;
const heapSamples = [];
const bad = [];

const poll = async () => {
  polls++;
  try {
    const r = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(5_000) });
    if (r.status === 200) stateOk++; else { errors5xx++; bad.push(`state ${r.status} @${Math.round((Date.now() - t0) / 60000)}min`); }
  } catch (e) { errors5xx++; bad.push(`state ERR ${String(e.message).slice(0, 60)} @${Math.round((Date.now() - t0) / 60000)}min`); }
  try {
    const r = await fetch(`${base}/api/cognitive`, { signal: AbortSignal.timeout(10_000) });
    if (r.status === 200) cogOk++; else { errors5xx++; bad.push(`cog ${r.status} @${Math.round((Date.now() - t0) / 60000)}min`); }
  } catch { /* cognitive probe optional */ }
  heapSamples.push(process.memoryUsage().heapUsed);
  if (polls % 10 === 0) {
    const min = Math.round((Date.now() - t0) / 60000);
    console.log(`heartbeat ${min}min: polls=${polls} stateOk=${stateOk} 5xx=${errors5xx} heap=${Math.round(heapSamples[heapSamples.length - 1] / 1e6)}MB`);
  }
};

await poll();
const loops = Math.floor((HOURS * 3_600_000) / INTERVAL_MS);
for (let i = 0; i < loops; i++) {
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
  await poll();
}
const upMs = Date.now() - t0;

const heapMin = Math.min(...heapSamples), heapMax = Math.max(...heapSamples);
const report = {
  window: `${HOURS}h`, uptimeMinutes: Math.round(upMs / 60000),
  polls, stateOk, cogOk, errors5xx,
  heapMinMB: Math.round(heapMin / 1e6), heapMaxMB: Math.round(heapMax / 1e6), heapGrowthMB: Math.round((heapMax - heapMin) / 1e6),
  bad: bad.slice(0, 10),
  // two-axis verdict: the zero-error bar conflates client-fetch health with
  // server health. serverHealth isolates the ORIGINAL question (drift/leak/
  // crash over the window); pass keeps the strict preregistered bar.
  serverHealth: stateOk + errors5xx === polls && !bad.some((b) => /state (4|5)\d\d/.test(b)) && (heapMax - heapMin) < 150 * 1e6 && upMs >= HOURS * 3_600_000 * 0.99,
  pass: errors5xx === 0 && stateOk === polls && (heapMax - heapMin) < 150 * 1e6 && upMs >= HOURS * 3_600_000 * 0.99,
};
// RESULT FILE FIRST — everything after this is best-effort
await writeFile(RESULT, JSON.stringify(report, null, 1));
console.log('RESULT WRITTEN: ' + JSON.stringify(report));
try { await handle.close(); } catch { /* already closed */ }
try { await rm(home, { recursive: true, force: true }); } catch { /* cleanup best-effort */ }
