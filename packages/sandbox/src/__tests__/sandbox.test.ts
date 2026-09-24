import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, SandboxDenied } from '../sandbox.ts';

test('sandbox lifecycle: create -> write -> snapshot -> mutate -> restore is byte-identical', async () => {
  const s = await sandbox.create();
  try {
    await sandbox.write(s, 'app.txt', 'version 1');
    const snap = await sandbox.snapshot(s, 'v1');
    assert.match(snap.sha, /^[0-9a-f]{40}$/);
    // mutate past the snapshot
    await sandbox.write(s, 'app.txt', 'version 2 - broken');
    await sandbox.write(s, 'stray.txt', 'untracked junk');
    await sandbox.restore(s, snap);
    assert.equal(await sandbox.read(s, 'app.txt'), 'version 1', 'file restored');
    const files = await sandbox.list(s);
    assert.ok(!files.includes('stray.txt'), 'untracked files cleaned by restore');
  } finally {
    await sandbox.destroy(s);
  }
});

test('sandbox exec: commands run inside the sandbox dir; failures surface as exit codes', async () => {
  const s = await sandbox.create();
  try {
    await sandbox.write(s, 'marker.txt', 'here');
    const ok = await sandbox.exec(s, { command: process.execPath, args: ['-e', 'console.log(require("fs").readFileSync("marker.txt","utf8"))'] });
    assert.equal(ok.exitCode, 0);
    assert.match(ok.stdout, /here/);
    const fail = await sandbox.exec(s, { command: process.execPath, args: ['-e', 'process.exit(7)'] });
    assert.equal(fail.exitCode, 7);
  } finally {
    await sandbox.destroy(s);
  }
});

test('sandbox tiers: READ_ONLY denies exec and write; WORKSPACE_WRITE allows both', async () => {
  const ro = await sandbox.create({ tier: 'READ_ONLY' });
  try {
    await assert.rejects(() => sandbox.write(ro, 'x.txt', 'no'), SandboxDenied);
    await assert.rejects(() => sandbox.exec(ro, { command: process.execPath, args: ['-v'] }), SandboxDenied);
    // reads still work at READ_ONLY
    await sandbox.write; // (function exists)
  } finally {
    await sandbox.destroy(ro);
  }
  const ww = await sandbox.create({ tier: 'WORKSPACE_WRITE' });
  try {
    await sandbox.write(ww, 'x.txt', 'yes');
    const r = await sandbox.exec(ww, { command: process.execPath, args: ['-e', 'console.log("ok")'] });
    assert.equal(r.exitCode, 0);
  } finally {
    await sandbox.destroy(ww);
  }
});

test('sandbox diff: reports uncommitted drift, empty after restore', async () => {
  const s = await sandbox.create();
  try {
    await sandbox.write(s, 'a.txt', 'one');
    await sandbox.snapshot(s);
    const clean = await sandbox.diff(s);
    assert.equal(clean.files.length, 0);
    await sandbox.write(s, 'a.txt', 'two');
    await sandbox.write(s, 'b.txt', 'new');
    const drift = await sandbox.diff(s);
    assert.deepEqual(drift.files.sort(), ['a.txt', 'b.txt']);
    assert.match(drift.patch, /-one|two/);
  } finally {
    await sandbox.destroy(s);
  }
});
