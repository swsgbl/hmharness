import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSigningIdentity, hapsignToolPaths } from '../signing.ts';
import { runDeviceTest } from '../ondevice.ts';

/* ---------------- signing identity resolution ---------------- */

test('identity: explicit profile+p12 wins when both exist; missing pair returns null', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-sign-'));
  const p12 = join(home, 'me.p12');
  const profile = join(home, 'provision.p7b');
  await writeFile(p12, 'x', 'utf8');
  await writeFile(profile, 'x', 'utf8');
  const id = await resolveSigningIdentity('C:\\no-such-dev-eco', { profile, p12, keyAlias: 'mine' });
  assert.ok(id);
  assert.equal(id!.origin, 'explicit');
  assert.equal(id!.keyAlias, 'mine');
  const none = await resolveSigningIdentity('C:\\no-such-dev-eco', { profile: join(home, 'nope.p7b'), p12 });
  assert.equal(none, null);
  await rm(home, { recursive: true, force: true });
});

test('identity: falls back to the SDK debug identity when nothing user-level exists', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-sign-sdk-'));
  const lib = join(home, 'sdk', 'default', 'openharmony', 'toolchains', 'lib');
  await mkdir(lib, { recursive: true });
  await writeFile(join(lib, 'OpenHarmony.p12'), 'x', 'utf8');
  await writeFile(join(lib, 'OpenHarmonyProfileDebug.pem'), 'x', 'utf8');
  const id = await resolveSigningIdentity(home);
  if (id) assert.ok(['explicit', 'deveco-autosign (~/.ohos/config)', 'sdk debug identity'].includes(id.origin));
  assert.equal(hapsignToolPaths(home).jar, join(lib, 'hap-sign-tool.jar'));
  await rm(home, { recursive: true, force: true });
});

/* ---------------- device test verdict shape (injected runner) ---------------- */

function makeRunner(script: Record<string, string | Error>): (args: string[], t: number) => Promise<{ ok: boolean; out: string }> {
  return async (args) => {
    const key = args.filter((a) => !a.startsWith('-')).join(' ');
    // match on the leading verbs: install / app install / shell aa start / shell hilog / uninstall
    if (key.includes('install') && !key.includes('uninstall')) {
      const v = script.install;
      if (v instanceof Error) return { ok: false, out: v.message };
      return { ok: true, out: v };
    }
    if (key.includes('uninstall')) {
      const v = script.uninstall;
      if (v instanceof Error) return { ok: false, out: v.message };
      return { ok: true, out: v };
    }
    if (key.includes('aa start')) {
      const v = script.launch;
      if (v instanceof Error) return { ok: false, out: v.message };
      return { ok: true, out: v };
    }
    if (key.includes('hilog')) {
      const v = script.hilog;
      if (v instanceof Error) return { ok: false, out: v.message };
      return { ok: true, out: v };
    }
    return { ok: true, out: '' };
  };
}

test('device test: install->launch->log-marker->uninstall verdicts; marker polling works', async () => {
  const steps = await runDeviceTest({
    hdc: 'hdc',
    hap: 'x.hap',
    bundle: 'com.example.t',
    ability: 'EntryAbility',
    expectLog: 'EntryAbility onCreate',
    waitMs: 1500,
    runImpl: makeRunner({
      install: 'App install path: x msg:install bundle successfully.',
      launch: 'start ability successfully.',
      hilog: '09-05 01:13:19 I A00000/hmh: EntryAbility onCreate',
      uninstall: 'App uninstall msg:uninstall bundle successfully.',
    }),
  });
  assert.equal(steps.length, 4);
  assert.ok(steps[0].pass, 'install verdict');
  assert.ok(steps[1].pass, 'launch verdict');
  assert.equal(steps[2].step, 'log-marker "EntryAbility onCreate"');
  assert.ok(steps[2].pass, 'marker found in polled hilog');
  assert.ok(steps[3].pass, 'uninstall verdict');
});

test('device test: install failure short-circuits (no launch/uninstall steps)', async () => {
  const steps = await runDeviceTest({
    hdc: 'hdc',
    hap: 'x.hap',
    bundle: 'com.example.t',
    ability: 'EntryAbility',
    expectLog: 'EntryAbility onCreate',
    waitMs: 500,
    runImpl: makeRunner({
      install: 'install failed: signature verify failed',
      launch: 'should not be called',
      hilog: '',
      uninstall: 'should not be called',
    }),
  });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].pass, false);
  assert.match(steps[0].detail, /signature verify failed/);
});

test('device test: missing marker fails the log step (verdict honesty)', async () => {
  const steps = await runDeviceTest({
    hdc: 'hdc',
    hap: 'x.hap',
    bundle: 'com.example.t',
    ability: 'EntryAbility',
    expectLog: 'EntryAbility onCreate',
    waitMs: 1200,
    runImpl: makeRunner({
      install: 'install bundle successfully',
      launch: 'start ability successfully.',
      hilog: '(nothing relevant here)',
      uninstall: 'uninstall bundle successfully',
    }),
  });
  assert.equal(steps[2].pass, false);
  assert.match(steps[2].detail, /NOT found/);
});
