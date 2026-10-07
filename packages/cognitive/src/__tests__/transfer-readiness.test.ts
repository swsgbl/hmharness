import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENVIRONMENT_IR,
  TRANSFER_ENVIRONMENTS,
  transferReadiness,
} from '../abstract-actions.ts';

test('environment IR: all five environments carry non-empty state/observation/verification', () => {
  for (const env of TRANSFER_ENVIRONMENTS) {
    const ir = ENVIRONMENT_IR[env];
    assert.ok(ir, `${env} has an IR entry`);
    assert.ok(ir.stateKeys.length > 0, `${env} stateKeys non-empty`);
    assert.ok(ir.observationKinds.length > 0, `${env} observationKinds non-empty`);
    assert.ok(ir.verificationOps.length > 0, `${env} verificationOps non-empty`);
    assert.equal(ir.environment, env);
  }
});

test('readiness: terminal write+run procedure is ready in terminal, blocked elsewhere with named verbs', () => {
  const proc = ['write', 'run'];
  const t = transferReadiness(proc, 'terminal');
  assert.equal(t.ready, true, `terminal should cover write+run (missing: ${t.missingVerbs})`);
  assert.deepEqual(t.missingVerbs, []);
  assert.ok(t.bindings['write'].includes('write_file'));
  assert.ok(t.bindings['run'].includes('run_command'));

  const b = transferReadiness(proc, 'browser');
  // browser's verbs: interact/navigate/observe/read - write/run absent
  assert.equal(b.ready, false);
  assert.ok(b.missingVerbs.includes('write'), 'write named as missing');
  assert.ok(b.missingVerbs.includes('run'), 'run named as missing');

  const d = transferReadiness(proc, 'desktop');
  assert.equal(d.ready, false);
  assert.ok(d.missingVerbs.length >= 2);
});

test('readiness: verify verb belongs to harmonyos - a verify-carrying procedure names it missing in terminal', () => {
  const proc = ['write', 'run', 'verify'];
  const t = transferReadiness(proc, 'terminal');
  assert.equal(t.ready, false, 'verify has no terminal literals (harmony_build/device_test are harmonyos)');
  assert.ok(t.missingVerbs.includes('verify'));
  const h = transferReadiness(proc, 'harmonyos');
  // harmonyos covers verify + run; write has no harmonyos literal -> named honestly
  assert.equal(h.ready, false);
  assert.ok(h.missingVerbs.includes('write'), 'write named as missing in harmonyos (hdc toolchain has no write literal)');
  assert.deepEqual(h.bindings['verify'], ['harmony_build', 'harmony_device_test']);
});

test('readiness: observe+interact procedure transfers to browser and desktop, not terminal', () => {
  const proc = ['observe', 'interact'];
  const br = transferReadiness(proc, 'browser');
  assert.equal(br.ready, true, `browser (missing: ${br.missingVerbs})`);
  const d = transferReadiness(proc, 'desktop');
  assert.equal(d.ready, true, `desktop (missing: ${d.missingVerbs})`);
  const a = transferReadiness(proc, 'arc3');
  assert.equal(a.ready, false, 'arc3 has interact but NO observe literals - named honestly');
  assert.ok(a.missingVerbs.includes('observe'));
  const t = transferReadiness(proc, 'terminal');
  assert.equal(t.ready, false);
  assert.ok(t.missingVerbs.includes('interact'), 'terminal has no interact literals - named honestly');
});
