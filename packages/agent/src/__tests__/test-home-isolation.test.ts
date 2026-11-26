/**
 * The suite never works in the developer's real home (2026-11-26).
 *
 * `npm test` preloads scripts/test-home.mjs. Without it, a test that never
 * thought about HMH_HOME wrote sessions, run trajectories and insights into
 * the real ~/.hmharness - the real home held 22 such trajectories ("run a
 * harmless command", provider fake://) and a pile of empty session files that
 * showed up in the user's /resume list and fed the self-evolution loop.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homeDir } from '@hmharness/kernel';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

test('this test process works in a home of its own, not in the real one', () => {
  const home = homeDir();
  assert.ok(home.toLowerCase().startsWith(tmpdir().toLowerCase()), `HMH_HOME is a temp directory: ${home}`);
  assert.ok(/hmh-(test-home|)/i.test(home), home);
});

test('npm test preloads the isolation, and the preload does what it says', () => {
  const pkg = JSON.parse(readFileSync(new URL('package.json', new URL('file://' + ROOT.replace(/\\/g, '/'))), 'utf8')) as { scripts: { test: string } };
  assert.match(pkg.scripts.test, /--import \.\/scripts\/test-home\.mjs/, 'the preload is part of the test command');

  const run = (env: Record<string, string>): string => spawnSync(
    process.execPath,
    ['--import', './scripts/test-home.mjs', '-e', 'process.stdout.write(String(process.env.HMH_HOME))'],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true },
  ).stdout ?? '';
  const made = run({ HMH_HOME: '' });
  assert.match(made, /hmh-test-home-/, 'a process with no home gets a temporary one');
  assert.equal(existsSync(made), false, 'and it is removed when the process ends');
  assert.equal(run({ HMH_HOME: 'X:/kept' }), 'X:/kept', 'a home the caller chose is respected');
});
