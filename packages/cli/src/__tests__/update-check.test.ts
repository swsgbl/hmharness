import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkForUpdate, cmpSemver, isBoardInstall, boardHomeFromDistDir, autoUpdate, loadReleaseNotes, noteFor } from '../update-check.ts';
import { renderStats, type PkgStat } from '../npm-stats.ts';

/* ------------- T27-v2: visible-but-windowless update notices + briefing ------------- */

function fakeChild() {
  const listeners: Record<string, Array<(code?: number) => void>> = {};
  const child = {
    unref: () => {},
    on: (ev: string, fn: (code?: number) => void) => { (listeners[ev] ??= []).push(fn); },
  };
  return { child, emit: (ev: string, code?: number) => { for (const fn of listeners[ev] ?? []) fn(code); } };
}

test('autoUpdate notices: say at start, onDone(code,version) when the installer exits (T27-v2)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-notice-'));
  const fetchImpl = (async () => new Response(JSON.stringify({ latest: '9.9.9' }), { status: 200 })) as unknown as typeof fetch;
  const fc = fakeChild();
  const said: string[] = [];
  const dones: Array<[number, string]> = [];
  try {
    await autoUpdate({
      home, current: '0.2.0', now: Date.now(), fetchImpl,
      say: (v) => said.push(v),
      onDone: (code, v) => dones.push([code, v]),
      sayFail: () => { throw new Error('sayFail must not fire for a started install'); },
      spawnImpl: () => fc.child as never,
    });
    assert.deepEqual(said, ['9.9.9'], 'one dim start line the moment the install launches');
    assert.equal(dones.length, 0, 'completion has not fired yet (installer still running)');
    fc.emit('close', 0);
    assert.deepEqual(dones, [[0, '9.9.9']], 'clean exit reports success with the version');
    // a runtime failure also reports once, honestly
    const fc2 = fakeChild();
    const dones2: Array<[number, string]> = [];
    await writeFile(join(home, 'updating.lck'), JSON.stringify({ time: 0 }), 'utf8'); // stale lock
    await autoUpdate({
      home, current: '0.2.0', now: Date.now(), fetchImpl,
      onDone: (c, v) => dones2.push([c, v]),
      spawnImpl: () => fc2.child as never,
    });
    fc2.emit('close', 1);
    assert.deepEqual(dones2, [[1, '9.9.9']], 'nonzero exit surfaces the code');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('release notes: shipped file loads, noteFor finds and never invents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hmh-notes-'));
  try {
    await mkdir(join(dir, 'dist'), { recursive: true });
    await writeFile(join(dir, 'release-notes.json'), JSON.stringify({ notes: [{ v: '1.2.3', note: '修复了更新提示' }, { v: '1.2.2', note: 'x' }] }), 'utf8');
    const notes = await loadReleaseNotes(join(dir, 'dist'));
    assert.ok(notes);
    assert.equal(noteFor(notes, '1.2.3'), '修复了更新提示');
    assert.equal(noteFor(notes, '0.0.0'), '', 'unknown version = empty, never fabricated');
    const bare = await mkdtemp(join(tmpdir(), 'hmh-notes2-'));
    await mkdir(join(bare, 'dist'), { recursive: true });
    assert.equal(await loadReleaseNotes(join(bare, 'dist')), null, 'missing file degrades to null');
    await rm(bare, { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the real shipped release-notes.json covers the running cli version (guard mirror)', async () => {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const cliV = req('../../package.json') as { version: string };
  const notes = await loadReleaseNotes();
  assert.ok(notes, 'shipped notes file must exist next to dist');
  assert.ok(noteFor(notes, cliV.version).length > 0, 'current version ' + cliV.version + ' must have a briefing entry');
});

test('cmpSemver: numeric per-component ordering (not lexicographic)', () => {
  assert.equal(cmpSemver('0.2.0', '0.2.0'), 0);
  assert.equal(cmpSemver('0.2.0', '0.10.0'), -1, '0.10 > 0.2 numerically; string compare would say otherwise');
  assert.equal(cmpSemver('1.0.0', '1.0.1'), -1);
  assert.equal(cmpSemver('2.0.0', '1.9.9'), 1);
  assert.equal(cmpSemver('0.2.0', '0.2.1-beta'), -1, 'prerelease suffix degrades to numeric 0 - fine for our hint');
});

test('checkForUpdate: outdated -> info; cache hit -> no network; failure -> null, no crash', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-upd-'));
  let fetches = 0;
  const fetchImpl = (async () => {
    fetches++;
    return new Response(JSON.stringify({ latest: '9.9.9' }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    // 1. outdated: current 0.2.0 vs latest 9.9.9
    const r1 = await checkForUpdate({ home, current: '0.2.0', fetchImpl });
    assert.deepEqual(r1, { current: '0.2.0', latest: '9.9.9' });
    assert.equal(fetches, 1);
    // cache file written
    const cache = JSON.parse(await readFile(join(home, 'update-check.json'), 'utf8'));
    assert.equal(cache.latest, '9.9.9');

    // 2. fresh cache: same answer, ZERO extra fetches
    const r2 = await checkForUpdate({ home, current: '0.2.0', fetchImpl });
    assert.equal(r2?.latest, '9.9.9');
    assert.equal(fetches, 1, 'cached answer must not hit the network');

    // 3. up-to-date: current equals latest -> null
    const r3 = await checkForUpdate({ home, current: '9.9.9', fetchImpl });
    assert.equal(r3, null);

    // 4. stale cache (older than 24h) -> refetch
    await writeFile(join(home, 'update-check.json'), JSON.stringify({ time: Date.now() - 25 * 3600_000, latest: '0.0.1' }), 'utf8');
    const r4 = await checkForUpdate({ home, current: '0.2.0', fetchImpl });
    assert.equal(fetches, 2);
    assert.equal(r4?.latest, '9.9.9');

    // 5. network throws -> null, never rejects
    const bad = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const home2 = await mkdtemp(join(tmpdir(), 'hmh-upd-'));
    const r5 = await checkForUpdate({ home: home2, current: '0.2.0', fetchImpl: bad });
    assert.equal(r5, null);
    await rm(home2, { recursive: true, force: true });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('renderStats: aligned table, absent values as dash, honesty footnote', () => {
  const rows: PkgStat[] = [
    { name: '@hmharness/cli', day: 36, week: 208, month: 208 },
    { name: '@hmharness/web', day: null, week: 22, month: 22 },
  ];
  const out = renderStats(rows);
  assert.match(out, /package\s+day\s+week\s+month/);
  assert.match(out, /@hmharness\/cli\s+36\s+208\s+208/);
  assert.match(out, /@hmharness\/web\s+-\s+22\s+22/);
  assert.match(out, /downloads, not users/);
});

/* ------------- T27/T28: silent background updates + board channel ------------- */

test('isBoardInstall / boardHomeFromDistDir: KaihongOS board layout detection', () => {
  const board = '/data/local/home/.local/hmharness/node_modules/@hmharness/cli/dist';
  assert.equal(isBoardInstall(board), true);
  assert.equal(boardHomeFromDistDir(board), '/data/local/home');
  // windows-style separators normalize
  assert.equal(isBoardInstall('C:\\b\\.local\\hmharness\\node_modules\\@hmharness\\cli\\dist'), true);
  assert.equal(boardHomeFromDistDir('C:\\b\\.local\\hmharness\\node_modules\\@hmharness\\cli\\dist'), 'C:/b');
  // npm-global and source layouts are NOT board installs
  assert.equal(isBoardInstall('/usr/lib/node_modules/@hmharness/cli/dist'), false);
  assert.equal(isBoardInstall('G:/hmharness/packages/cli/src'), false);
  assert.equal(boardHomeFromDistDir('/usr/lib/node_modules/@hmharness/cli/dist'), '');
});

test('autoUpdate standard path: silent on success, windowsHide, lock written', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-silent-'));
  const fetchImpl = (async () => new Response(JSON.stringify({ latest: '9.9.9' }), { status: 200 })) as unknown as typeof fetch;
  const spawns: Array<{ cmd: string; args: string[]; opts: { windowsHide?: boolean; detached?: boolean } }> = [];
  const spawnImpl = ((cmd: string, args: string[], opts: { windowsHide?: boolean; detached?: boolean }) => {
    spawns.push({ cmd, args, opts });
    return { unref: () => {}, on: () => {} };
  }) as unknown as NonNullable<Parameters<typeof autoUpdate>[0]['spawnImpl']>;
  try {
    await autoUpdate({ home, current: '0.2.0', sayFail: () => { throw new Error('sayFail must not fire on success'); }, spawnImpl, now: Date.now(), fetchImpl });
    assert.equal(spawns.length, 1, 'exactly one installer spawn');
    assert.equal(spawns[0]!.opts.windowsHide, true, 'T27: detached cmd.exe/npm must be hidden');
    assert.equal(spawns[0]!.opts.detached, true);
    assert.notEqual(spawns[0]!.cmd, 'cmd.exe', 'T27 v2: no shim route when npm-cli.js is reachable - run node+npm-cli.js directly');
    const lock = JSON.parse(await readFile(join(home, 'updating.lck'), 'utf8'));
    assert.equal(lock.to, '9.9.9');
    assert.equal(lock.via, undefined, 'standard path has no via marker');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('autoUpdate board path: runs the SHIPPED installer with --home, silent, lock via board-installer', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-board-'));
  // fabricate the board layout: <bhome>/.local/hmharness/node_modules/@hmharness/cli/{dist,board}
  const bhome = join(home, 'bhome');
  const cliPkg = join(bhome, '.local', 'hmharness', 'node_modules', '@hmharness', 'cli');
  const distDir = join(cliPkg, 'dist');
  await mkdir(distDir, { recursive: true });
  await mkdir(join(cliPkg, 'board'), { recursive: true });
  await writeFile(join(cliPkg, 'board', 'install-kaihongos.cjs'), '#!/usr/bin/env node\n// stub\n', 'utf8');
  const fetchImpl = (async () => new Response(JSON.stringify({ latest: '9.9.9' }), { status: 200 })) as unknown as typeof fetch;
  const spawns: Array<{ cmd: string; args: string[]; opts: { windowsHide?: boolean } }> = [];
  const spawnImpl = ((cmd: string, args: string[], opts: { windowsHide?: boolean }) => {
    spawns.push({ cmd, args, opts });
    return { unref: () => {}, on: () => {} };
  }) as unknown as NonNullable<Parameters<typeof autoUpdate>[0]['spawnImpl']>;
  try {
    await autoUpdate({ home, current: '0.21.0', sayFail: () => { throw new Error('sayFail must not fire when the board path starts'); }, spawnImpl, distDir, now: Date.now(), fetchImpl });
    assert.equal(spawns.length, 1, 'board path spawns the installer, never npm');
    assert.equal(spawns[0]!.cmd, process.execPath, 'runs on the RUNNING node (board node.bin)');
    const scriptArg = spawns[0]!.args.find((a) => a.endsWith('install-kaihongos.cjs'));
    assert.ok(scriptArg, 'invokes the shipped board installer script');
    assert.ok(spawns[0]!.args.some((a) => a === '--home=' + bhome.replace(/\\/g, '/')), 'passes the derived board home: ' + JSON.stringify(spawns[0]!.args));
    const lock = JSON.parse(await readFile(join(home, 'updating.lck'), 'utf8'));
    assert.equal(lock.via, 'board-installer');
    assert.equal(lock.to, '9.9.9');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
