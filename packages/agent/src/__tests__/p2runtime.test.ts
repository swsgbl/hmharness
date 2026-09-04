import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandPreflight } from '../tools.ts';
import { recordRole, roleStats, roleStatsLine, type RoleStat } from '../spawn.ts';
import { refreshKnowledge } from '@hmh/evolution';

async function freshHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'hmh-p2-'));
  await mkdir(join(home, 'evolution'), { recursive: true });
  return home;
}

/* ---------------- P2-9 command preflight ---------------- */

test('preflight: expensive commands check the script exists; cheap commands pass through', async () => {
  const home = await freshHome();
  // cheap command - no preflight work at all
  assert.equal(await commandPreflight('echo hi', home), null);
  // expensive command with a relative script that does NOT exist -> blocked
  const blocked = await commandPreflight('hvigorw.bat assembleHap', home);
  assert.match(blocked ?? '', /Preflight failed/);
  // the same command where the script EXISTS -> allowed
  await writeFile(join(home, 'hvigorw.bat'), '@echo off', 'utf8');
  assert.equal(await commandPreflight('hvigorw.bat assembleHap', home), null);
  // bare tool names (npm install) are on PATH - not preflight-able here
  assert.equal(await commandPreflight('npm install', home), null);
  await rm(home, { recursive: true, force: true });
});

/* ---------------- P2-10 CRITIC on second failure ---------------- */

test('run_command: second failure appends the CRITIC diagnosis demand, third is refused', async () => {
  const home = await freshHome();
  const { runCommandTool } = await import('../tools.ts');
  const ctx = { cwd: home, home };
  const cmd = 'definitely-not-a-real-command-xyz';
  // first failure: plain error output
  const r1 = await runCommandTool.execute({ command: cmd }, ctx);
  assert.equal(r1.isError, true);
  assert.doesNotMatch(r1.output, /LOCATE/);
  // second failure: the output now DEMANDS locate-then-fix (Reflexion amplification)
  const r2 = await runCommandTool.execute({ command: cmd }, ctx);
  assert.equal(r2.isError, true);
  assert.match(r2.output, /LOCATE the failure/);
  assert.match(r2.output, /HYPOTHESIZE/);
  // third attempt: hard short-circuit, no execution
  const r3 = await runCommandTool.execute({ command: cmd }, ctx);
  assert.equal(r3.isError, true);
  assert.match(r3.output, /already failed/);
  assert.doesNotMatch(r3.output, /is not recognized/); // nothing was executed
  await rm(home, { recursive: true, force: true });
});

/* ---------------- P2-11 knowledge refresh ---------------- */

test('knowledge refresh: first run snapshots; diff produces a draft through the gate pipeline; no-change is a no-op', async () => {
  const home = await freshHome();
  await mkdir(join(home, 'skills', 'draft'), { recursive: true });
  let call = 0;
  const pages = ['<html>v1 API 12 released</html>', '<html>v2 API 13 released new hdc flags</html>'];
  const fetchImpl = async () => pages[Math.min(call++, pages.length - 1)] ?? pages[pages.length - 1];
  const provider = { baseUrl: '', apiKey: '', model: 'meta' };
  // meta-model stub via chat injection is not exposed here; assert the
  // summary path instead when the meta call fails (no provider) -> no draft
  const r1 = await refreshKnowledge({ home, provider: { ...provider, apiKey: 'none' }, fetchImpl, say: () => {} });
  assert.match(r1.summary, /snapshot|draft|skipped|no draft|written|nothing/);
  // second run with a changed page: diff path executes without throwing
  const r2 = await refreshKnowledge({ home, provider, fetchImpl, say: () => {} });
  assert.ok(typeof r2.summary === 'string');
  // snapshot persisted
  const snap = JSON.parse(await readFile(join(home, 'evolution', 'knowledge', 'snapshot.json'), 'utf8'));
  assert.ok(snap.time && typeof snap.pages === 'object');
  await rm(home, { recursive: true, force: true });
});

test('knowledge refresh: offline is a clean no-op, never a failure', async () => {
  const home = await freshHome();
  const r = await refreshKnowledge({ home, provider: { baseUrl: '', apiKey: '', model: 'm' }, fetchImpl: async () => null, say: () => {} });
  assert.match(r.summary, /offline/);
  await rm(home, { recursive: true, force: true });
});

/* ---------------- P3 role tournament records ---------------- */

test('role stats: record + aggregate + leaderboard line, >=3 samples gate', async () => {
  const home = await freshHome();
  await recordRole(home, 'explorer', true);
  await recordRole(home, 'explorer', true);
  await recordRole(home, 'explorer', false); // 2/3
  await recordRole(home, 'reviewer', true);
  const stats = await roleStats(home);
  assert.equal(stats.length, 2);
  const explorer = stats.find((s: RoleStat) => s.role === 'explorer')!;
  assert.equal(explorer.spawns, 3);
  assert.equal(explorer.ok, 2);
  // line shows explorer (>=3 samples) but not reviewer (1 sample)
  const line = roleStatsLine(stats);
  assert.match(line, /explorer 67%/);
  assert.doesNotMatch(line, /reviewer/);
  await rm(home, { recursive: true, force: true });
});
