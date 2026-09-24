import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allScenarios, checkRecovery, chaosReport, type ChaosResult } from '../chaos.ts';

test('allScenarios returns >=6 scenarios', () => {
  assert.ok(allScenarios().length >= 6);
  assert.ok(allScenarios().includes('kill-process'));
  assert.ok(allScenarios().includes('restart-daemon'));
});

test('checkRecovery: all pass = recovered', () => {
  const r = checkRecovery([{ name: 'a', pass: true }, { name: 'b', pass: true }]);
  assert.equal(r.recovered, true);
  assert.equal(r.failed.length, 0);
});

test('checkRecovery: any fail = not recovered', () => {
  const r = checkRecovery([{ name: 'a', pass: true }, { name: 'b', pass: false }]);
  assert.equal(r.recovered, false);
  assert.deepEqual(r.failed, ['b']);
});

test('chaosReport formats results', () => {
  const results: ChaosResult[] = [
    { scenario: 'kill-process', survived: true, recovered: true, recoveryMs: 500, notes: 'ok' },
    { scenario: 'corrupt-workspace', survived: true, recovered: false, recoveryMs: 0, notes: 'lost data' },
  ];
  const report = chaosReport(results);
  assert.ok(report.includes('2 scenarios'));
  assert.ok(report.includes('kill-process'));
  assert.ok(report.includes('1/2 recovered'));
});
