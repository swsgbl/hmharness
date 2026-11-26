import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonCwd, isInside, packageRootOf } from '../daemon-cwd.ts';

/** A daemon lives as long as the machine is up and holds its working directory
 *  for all of it; on Windows that handle locks the directory against rename and
 *  delete. One started from inside the installed package (a launcher that cd's
 *  there first) blocked the next `npm i -g` with EBUSY until it was killed -
 *  seen on the v0.23.53 upgrade. */

test('daemonCwd: the caller\'s directory is kept, unless it is the installed package', () => {
  const root = mkdtempSync(join(tmpdir(), 'hmh-cwd-'));
  const prevHome = process.env.HMH_HOME;
  process.env.HMH_HOME = join(root, 'home');
  try {
    const pkg = join(root, 'npm', 'node_modules', '@hmharness', 'cli');
    const entry = join(pkg, 'dist', 'main.js');
    assert.equal(packageRootOf(entry), pkg, '<package>/dist/main.js -> <package>');

    assert.equal(daemonCwd(join(root, 'project'), entry), join(root, 'project'),
      "kept: the web daemon seeds its first workspace from the caller's directory");
    assert.equal(daemonCwd(pkg, entry), process.env.HMH_HOME, 'the package directory itself -> HMH_HOME');
    assert.equal(daemonCwd(join(pkg, 'dist'), entry), process.env.HMH_HOME, 'and anywhere below it');
    assert.equal(daemonCwd(join(pkg, '..', 'cli-extra', 'x'), entry), join(pkg, '..', 'cli-extra', 'x'),
      'a neighbour whose name merely starts the same way is NOT inside');

    if (process.platform === 'win32') {
      const cased = join(root, 'NPM', 'NODE_MODULES', '@HMHARNESS', 'CLI', 'Dist');
      assert.equal(daemonCwd(cased, entry), process.env.HMH_HOME, 'Windows paths are case-insensitive');
      assert.equal(daemonCwd(join(root, 'PROJECT'), entry), join(root, 'PROJECT'));
    }
  } finally {
    if (prevHome === undefined) delete process.env.HMH_HOME;
    else process.env.HMH_HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('isInside: a directory is inside itself; a same-prefix sibling is not; relative paths resolve first', () => {
  const a = join(tmpdir(), 'hmh-a');
  assert.equal(isInside(a, a), true);
  assert.equal(isInside(a, join(a, 'b', 'c')), true);
  assert.equal(isInside(a, a + '-2'), false, 'prefix match alone is not containment');
  // relative paths resolve against the process cwd before they are compared
  assert.equal(isInside(process.cwd(), 'packages'), true);
  assert.equal(isInside(process.cwd(), join('packages', '..', 'packages', 'cli')), true, 'the .. is resolved away first');
  assert.equal(isInside(join(process.cwd(), 'packages', 'cli'), 'packages'), false, 'it resolves to <cwd>/packages, which CONTAINS the base');
});

test('the web and extension daemons are spawned through daemonCwd (neither inherits the package directory)', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['web-daemon.ts', 'extension-daemon.ts']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.equal((src.match(/cwd: process\.cwd\(\)/g) || []).length, 0, `${f}: no bare cwd: process.cwd() left`);
    const through = (src.match(/cwd: daemonCwd\(process\.cwd\(\), entry\)/g) || []).length;
    assert.equal(through, f === 'web-daemon.ts' ? 1 : 2, `${f}: every daemon spawn goes through daemonCwd (bridge, and the bridge's watchdog)`);
  }
});
