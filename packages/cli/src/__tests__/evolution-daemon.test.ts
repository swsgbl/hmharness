import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { daemonRunnerSource, evolutionSpawnOptions, evolutionDaemonPid, ensureEvolutionDaemon, stopEvolutionDaemon } from '../evolution-daemon.ts';

test('daemon runner is valid plain CJS (0.14.25 regression: top-level await + ESM import in .cjs died instantly)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hmh-daemon-'));
  try {
    const src = daemonRunnerSource('evolution-daemon.pid', 'G:\\abs\\path\\to\\main.js');
    // the runner must parse as CJS - node --check exits non-zero on syntax errors
    const p = join(dir, 'runner.cjs');
    writeFileSync(p, src, 'utf8');
    execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' });
    assert.ok(/hmhEntry = "G:\\\\abs\\\\path\\\\to\\\\main\.js"/.test(src), 'entry path baked in verbatim');
    assert.ok(!/^\s*import\s/m.test(src), 'no ESM import statements');
    assert.ok(!/^\s*await\s+import\(/.test(src), 'no top-level await');
    // the two cycles are scheduled: evolve first, then the finetune gate
    assert.ok(src.includes("'evolve'") && src.includes("'auto-finetune', '--submit'"));
    assert.match(src, /String\(evo\.err\)\.slice\(0, 120\)/, 'the cycle log names the error object, not "[object Object]"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- identity and lifecycle (2026-11-26) ----
//
// The pid file alone used to mean "daemon alive". It outlives its process (a
// runner killed on Windows gets no SIGTERM and never cleans up) and pids are
// reused, so a stranger wearing the old number read as the daemon: evolution
// silently never restarted, and a stop would have killed the stranger.

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitUntil(pred: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A real, live process that looks exactly like our runner (same file name), or a stranger. */
function liveProcess(home: string, kind: 'runner' | 'stranger'): ChildProcess {
  if (kind === 'runner') {
    // stays up, does nothing: the real runner's first cycle is 30s away
    writeFileSync(join(home, 'evolution-daemon-runner.cjs'), 'setInterval(function () {}, 1000);\n', 'utf8');
    return spawn(process.execPath, [join(home, 'evolution-daemon-runner.cjs')], { stdio: 'ignore' });
  }
  return spawn(process.execPath, ['-e', 'setInterval(function () {}, 1000)'], { stdio: 'ignore' });
}

async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.HMH_HOME;
    else process.env.HMH_HOME = prev;
  }
}

async function tempHome(): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), 'hmh-evo-'));
  // give the directory a moment so a freshly spawned child can be seen by name queries
  mkdirSync(join(home, 'evolution'), { recursive: true });
  return home;
}

test('the runner is launched in a scratch directory of its own, never the caller\'s', () => {
  const home = mkdtempSync(join(tmpdir(), 'hmh-evo-'));
  try {
    const { runnerPath, cwd } = evolutionSpawnOptions(home);
    assert.equal(cwd, join(home, 'evolution', 'scratch'), 'the evolve children run their bench cases here');
    assert.ok(existsSync(cwd), 'created on demand');
    assert.equal(runnerPath, join(home, 'evolution-daemon-runner.cjs'));
    // and the spawn really uses it: read from the source (a serialized function
    // comes back whitespace-stripped under tsx, so it is no stable thing to match)
    const src = readFileSync(new URL('../evolution-daemon.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export function ensureEvolutionDaemon('));
    assert.match(body, /const \{ runnerPath, cwd \} = evolutionSpawnOptions\(home\);/);
    assert.match(body, /spawn\(process\.execPath, \[runnerPath\], \{[^}]*\bcwd,/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a real runner is recognised, and stop ends it and clears the pid file', async () => {
  const home = await tempHome();
  const runner = liveProcess(home, 'runner');
  try {
    writeFileSync(join(home, 'evolution-daemon.pid'), String(runner.pid), 'utf8');
    const pid = runner.pid!;
    await waitUntil(() => alive(pid));
    const seen = await withHome(home, async () => {
      const mine = evolutionDaemonPid(home);
      const started = ensureEvolutionDaemon();   // must NOT spawn a second runner
      return { mine, started };
    });
    assert.equal(seen.mine, pid, 'recognised by its command line');
    assert.equal(seen.started.started, false, 'alive -> not started again');
    assert.equal(readFileSync(join(home, 'evolution-daemon.pid'), 'utf8').trim(), String(pid));

    assert.equal(await withHome(home, async () => stopEvolutionDaemon()), true);
    await waitUntil(() => !alive(pid));
    assert.equal(existsSync(join(home, 'evolution-daemon.pid')), false, 'the pid file is removed (the old ESM `require` unlink never ran)');
  } finally {
    try { runner.kill(); } catch { /* gone */ }
    rmSync(home, { recursive: true, force: true });
  }
});

test('a stranger wearing the old pid is NOT the daemon: evolution reports none, and a stop leaves it alive', async () => {
  const home = await tempHome();
  const stranger = liveProcess(home, 'stranger');
  try {
    const pid = stranger.pid!;
    writeFileSync(join(home, 'evolution-daemon.pid'), String(pid), 'utf8');
    await waitUntil(() => alive(pid));
    const res = await withHome(home, async () => ({ pid: evolutionDaemonPid(home), stopped: stopEvolutionDaemon() }));
    assert.equal(res.pid, null, 'not ours');
    assert.equal(res.stopped, false, 'nothing of ours was stopped');
    assert.ok(alive(pid), 'the stranger survives a `hmh web stop`');
    assert.equal(existsSync(join(home, 'evolution-daemon.pid')), false, 'the stale file is cleared either way');
  } finally {
    try { stranger.kill(); } catch { /* gone */ }
    rmSync(home, { recursive: true, force: true });
  }
});

test('a dead or garbage pid file reads as "no daemon"', async () => {
  const home = await tempHome();
  try {
    for (const raw of ['999999999', 'abc', '0', '-5', '', '1.5']) {
      writeFileSync(join(home, 'evolution-daemon.pid'), raw, 'utf8');
      assert.equal(evolutionDaemonPid(home), null, `pid file "${raw}"`);
    }
    assert.equal(evolutionDaemonPid(home + '-does-not-exist'), null, 'no file at all');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
