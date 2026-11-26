/**
 * Stopping a daemon must never kill a stranger (2026-11-26).
 *
 * Every daemon here is found through a pid file, and a pid file outlives its
 * process: a daemon killed on Windows never cleans up, and the OS reuses pids.
 * So `hmh web stop`, `hmh extension stop` and the extension watchdog's 60s
 * sweep all used to taskkill whatever the stale file named - or, for the
 * bridge, whatever sat on its port. These tests put a REAL stranger process
 * behind each pid file and require it to survive.
 *
 * Everything runs against a temporary HMH_HOME and a port verified free, so
 * nothing here can reach a daemon that happens to live on this machine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stopWebDaemon, parsePort } from '../web-daemon.ts';
import { stopExtensionDaemon, stopWatchdog, watchdogPidPath } from '../extension-daemon.ts';
import { commandLineOf, identifyProcess, isAlive, forgetIdentities } from '../process-identity.ts';

async function waitUntil(pred: () => boolean, what: string, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Give an asynchronous kill the time to land, so "still alive" means something. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 1500));

/** A live process that does nothing, started from `rel` under `home` - so its
 *  command line looks exactly like a daemon installed there. */
function sleeper(home: string, rel: string, argv: string[] = []): ChildProcess {
  const file = join(home, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'setInterval(function () {}, 1000);\n', 'utf8');
  return spawn(process.execPath, [file, ...argv], { stdio: 'ignore' });
}

/** A live process that is nobody of ours (kept under the test's own temp home). */
function stranger(home: string): ChildProcess {
  return sleeper(home, 'unrelated.cjs');
}

/** Another program listening on a port of its own: prints the port, then stays up. */
async function foreignListener(home: string): Promise<{ child: ChildProcess; port: number }> {
  const file = join(home, 'someone-else.cjs');
  writeFileSync(file, "const s = require('node:net').createServer(); s.listen(0, '127.0.0.1', () => console.log(s.address().port));\n", 'utf8');
  const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'ignore'] });
  const port = await new Promise<number>((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const line = out.split(/\r?\n/)[0];
      if (line && Number.isInteger(Number(line))) resolve(Number(line));
    });
    child.on('exit', () => reject(new Error('foreign listener exited early')));
  });
  return { child, port };
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.HMH_HOME;
    else process.env.HMH_HOME = prev;
    forgetIdentities();
  }
}

/** Kill and forget a test process, whatever state it is in. */
function dispose(child: ChildProcess | undefined): void {
  if (!child || child.pid === undefined || !isAlive(child.pid)) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  } else {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }
}

const tempHome = (): string => mkdtempSync(join(tmpdir(), 'hmh-stop-'));

// ---------- the identity test itself ----------

test('identity: a process is judged by its command line - ours, somebody else\'s, or unreadable', async () => {
  const home = tempHome();
  const ours = sleeper(home, join('pkg', 'dist', 'main.js'), ['web', '--port=65534']);
  const other = stranger(home);
  try {
    await waitUntil(() => isAlive(ours.pid!) && isAlive(other.pid!), 'both processes up');
    assert.match(commandLineOf(ours.pid!)!, /main\.js web --port=65534$/, 'the real command line, as the OS reports it');
    const isWeb = (c: string): boolean => /\bweb\b/.test(c);
    assert.equal(identifyProcess(ours.pid!, isWeb), 'self');
    assert.equal(identifyProcess(other.pid!, isWeb), 'other');
    assert.equal(identifyProcess(999_999_999, () => true), 'unknown', 'a dead pid has no command line to judge');
  } finally {
    dispose(ours); dispose(other);
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------- parsePort ----------

test('parsePort: only a real port counts; an empty or absurd --port= is the default', () => {
  assert.equal(parsePort(['--port=7799'], 7788), 7799);
  assert.equal(parsePort(['stop', '--port=1'], 7788), 1);
  assert.equal(parsePort([], 7788), 7788);
  for (const bad of ['--port=', '--port=0', '--port=70000', '--port=-1', '--port=abc', '--port=1.5', '--port= ']) {
    assert.equal(parsePort([bad], 7788), 7788, bad);
  }
});

// ---------- web ----------

test('hmh web stop: a stranger behind web.pid survives, and the stale file is cleared', async () => {
  const home = tempHome();
  const port = await freePort();
  const other = stranger(home);
  try {
    writeFileSync(join(home, 'web.pid'), String(other.pid), 'utf8');
    await waitUntil(() => isAlive(other.pid!), 'stranger up');
    const killed = await withHome(home, async () => stopWebDaemon(port));
    assert.equal(killed, false, 'nothing of ours was stopped');
    await settle();
    assert.ok(isAlive(other.pid!), 'the stranger is NOT killed');
    assert.equal(existsSync(join(home, 'web.pid')), false, 'the stale file is gone');
  } finally {
    dispose(other);
    rmSync(home, { recursive: true, force: true });
  }
});

test('hmh web stop: a real web daemon behind web.pid is stopped', async () => {
  const home = tempHome();
  const port = await freePort();
  const daemon = sleeper(home, join('pkg', 'dist', 'main.js'), ['web', '--port=65534']);
  try {
    const pid = daemon.pid!;
    writeFileSync(join(home, 'web.pid'), String(pid), 'utf8');
    await waitUntil(() => isAlive(pid), 'daemon up');
    assert.equal(await withHome(home, async () => stopWebDaemon(port)), true);
    await waitUntil(() => !isAlive(pid), 'the daemon ends');
    assert.equal(existsSync(join(home, 'web.pid')), false);
  } finally {
    dispose(daemon);
    rmSync(home, { recursive: true, force: true });
  }
});

/** An orphaned web daemon of ours: no pid file, but it holds its port. */
async function orphanWebDaemon(home: string): Promise<{ child: ChildProcess; port: number }> {
  const port = await freePort();
  const file = join(home, 'pkg', 'dist', 'main.js');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `require('node:net').createServer().listen(${port}, '127.0.0.1');\n`, 'utf8');
  return { child: spawn(process.execPath, [file, 'web', `--port=${port}`], { stdio: 'ignore' }), port };
}

const listens = (port: number, pid: number): boolean => {
  const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
  return out.split('\n').some((line) => line.trim().match(new RegExp(`^TCP\\s+\\S*?:${port}\\s+\\S+\\s+LISTENING\\s+${pid}$`)));
};

test('hmh web stop targets the port it is given: an orphan on P is evicted through P and untouched through another port', { skip: process.platform === 'win32' ? false : 'the port owner is looked up with netstat (Windows only; elsewhere the pid file is all there is)' }, async () => {
  const home = tempHome();
  const orphan = await orphanWebDaemon(home);
  const elsewhere = await freePort();
  try {
    await waitUntil(() => listens(orphan.port, orphan.child.pid!), 'the orphan is listening');
    assert.equal(await withHome(home, async () => stopWebDaemon(elsewhere)), false, 'another port names nothing of ours');
    await settle();
    assert.ok(isAlive(orphan.child.pid!), 'the orphan on P is untouched by a stop asked for another port');
    assert.equal(await withHome(home, async () => stopWebDaemon(orphan.port)), true, 'the port it holds names it');
    await waitUntil(() => !isAlive(orphan.child.pid!), 'the orphan is evicted');
  } finally {
    dispose(orphan.child);
    rmSync(home, { recursive: true, force: true });
  }
});

test('the `web stop` command hands its --port to the daemon stop, and stops the evolution daemon with it', async () => {
  // read from the source: the command itself is never run here, because a
  // regression in exactly this line would stop a real daemon on a dev machine
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
  const web = src.slice(src.indexOf("if (cmd === 'web') {"));
  const stopBranch = web.slice(web.indexOf("if (sub === 'stop') {"), web.indexOf("if (sub === 'status') {"));
  assert.match(stopBranch, /stopWebDaemon\(port\)/, 'the parsed port - until 0.23.55 this was stopWebDaemon(), always the default port');
  assert.match(stopBranch, /stopEvolutionDaemon\(\)/, 'the evolution daemon rides along');
  assert.match(web, /const port = parsePort\(rest, 7788\);/, 'one parser for the whole command');
  assert.doesNotMatch(src, /Number\.isFinite\(port\) \? port : 7788/, 'no second reading of --port beside parsePort');
});

// ---------- extension bridge ----------

test('hmh extension stop: a stranger behind the pid file survives, and a foreign holder of the port is left alone', async () => {
  const home = tempHome();
  const holder = await foreignListener(home);
  const other = stranger(home);
  try {
    writeFileSync(join(home, 'extension.pid'), String(other.pid), 'utf8');
    await waitUntil(() => isAlive(other.pid!), 'stranger up');
    // the bridge's own port: before 0.23.55 the watchdog taskkilled such a listener every minute
    const killed = await withHome(home, async () => stopExtensionDaemon(holder.port));
    await settle();
    assert.ok(isAlive(other.pid!), 'the stranger behind the pid file is NOT killed');
    assert.equal(existsSync(join(home, 'extension.pid')), false, 'the stale file is gone');
    assert.ok(isAlive(holder.child.pid!), 'the program on the port is NOT killed');
    assert.equal(killed, false, 'and neither counts as a kill');
  } finally {
    dispose(holder.child);
    dispose(other);
    rmSync(home, { recursive: true, force: true });
  }
});

test('hmh extension stop: the bridge of ours is stopped', async () => {
  const home = tempHome();
  const port = await freePort();
  const bridge = sleeper(home, join('pkg', 'dist', 'main.js'), ['extension', 'serve', '--port=65535']);
  try {
    const pid = bridge.pid!;
    writeFileSync(join(home, 'extension.pid'), String(pid), 'utf8');
    await waitUntil(() => isAlive(pid), 'bridge up');
    assert.equal(await withHome(home, async () => stopExtensionDaemon(port)), true);
    await waitUntil(() => !isAlive(pid), 'the bridge ends');
  } finally {
    dispose(bridge);
    rmSync(home, { recursive: true, force: true });
  }
});

test('hmh extension stop: the watchdog pid file gets the same judgement', async () => {
  const home = tempHome();
  const other = stranger(home);
  const dog = sleeper(home, join('pkg', 'dist', 'extension-watchdog-task.cjs'));
  try {
    await waitUntil(() => isAlive(other.pid!) && isAlive(dog.pid!), 'both up');
    // every write goes to the pid file UNDER THE TEMP HOME (watchdogPidPath follows HMH_HOME)
    const first = await withHome(home, async () => {
      writeFileSync(watchdogPidPath(), String(other.pid), 'utf8');
      return stopWatchdog();
    });
    await settle();
    assert.ok(isAlive(other.pid!), 'the stranger is NOT killed');
    assert.equal(first, false);

    assert.equal(await withHome(home, async () => {
      writeFileSync(watchdogPidPath(), String(dog.pid), 'utf8');
      return stopWatchdog();
    }), true);
    await waitUntil(() => !isAlive(dog.pid!), 'the watchdog of ours ends');
  } finally {
    dispose(other); dispose(dog);
    rmSync(home, { recursive: true, force: true });
  }
});
