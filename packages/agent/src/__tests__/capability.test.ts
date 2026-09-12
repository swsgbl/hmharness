import test from 'node:test';
import assert from 'node:assert/strict';
import { manifestFor, capabilityReport, authorize } from '../capability.ts';
import { baseTools } from '../tools.ts';
import { Registry } from '@hmharness/kernel';

test('every registered tool projects onto a manifest', () => {
  const reg = new Registry();
  for (const t of baseTools) reg.register(t);
  const report = capabilityReport(reg);
  assert.equal(report.length, baseTools.length);
  for (const m of report) {
    assert.match(m.id, /^[a-z_]+$/);
    assert.ok(['low', 'medium', 'high', 'critical'].includes(m.risk));
    assert.ok(m.description.length > 0);
    assert.ok(Array.isArray(m.permissions) && m.permissions.length > 0);
  }
  const byId = new Map(report.map((m) => [m.id, m]));
  assert.equal(byId.get('run_command')?.risk, 'high');
  assert.ok(byId.get('run_command')?.permissions.includes('process.spawn'));
  assert.equal(byId.get('read_file')?.risk, 'low');
  assert.equal(byId.get('edit_file')?.requiresApproval, true, 'gated tool declares its gate');
});

test('lockdown denies host/device reach; standard allows with gates', () => {
  const run = manifestFor({ ...baseTools.find((t) => t.name === 'run_command')! });
  const read = manifestFor({ ...baseTools.find((t) => t.name === 'read_file')! });
  const lock = authorize(run, 'lockdown');
  assert.equal(lock.allow, false);
  assert.match(lock.reason, /lockdown/);
  assert.equal(authorize(read, 'lockdown').allow, true, 'pure read survives lockdown');
  assert.equal(authorize(run, 'standard').allow, true);
  assert.match(authorize(run, 'standard').reason, /approval gate/);
  // revocation beats every mode
  assert.equal(authorize(read, 'standard', new Set(['read_file'])).allow, false);
});
