import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendedIsolation, isolationCost, MicroVMSandboxProvider } from '../microvm.ts';

test('recommendedIsolation: critical risk -> microvm', () => {
  assert.equal(recommendedIsolation({ riskLevel: 'critical', taskDuration: 1000, hasNetworkAccess: false }), 'microvm');
});

test('recommendedIsolation: high risk + long duration -> microvm', () => {
  assert.equal(recommendedIsolation({ riskLevel: 'high', taskDuration: 120000, hasNetworkAccess: false }), 'microvm');
});

test('recommendedIsolation: high risk + short duration -> container', () => {
  assert.equal(recommendedIsolation({ riskLevel: 'high', taskDuration: 30000, hasNetworkAccess: false }), 'container');
});

test('recommendedIsolation: network access -> container', () => {
  assert.equal(recommendedIsolation({ riskLevel: 'medium', taskDuration: 1000, hasNetworkAccess: true }), 'container');
});

test('recommendedIsolation: low risk -> process', () => {
  assert.equal(recommendedIsolation({ riskLevel: 'low', taskDuration: 1000, hasNetworkAccess: false }), 'process');
});

test('isolationCost: microvm is most expensive', () => {
  const proc = isolationCost('process');
  const cont = isolationCost('container');
  const vm = isolationCost('microvm');
  assert.ok(vm.startupMs > cont.startupMs && cont.startupMs > proc.startupMs);
  assert.ok(vm.memoryMb > cont.memoryMb && cont.memoryMb > proc.memoryMb);
});

test('isolationCost: has description', () => {
  for (const level of ['process', 'container', 'microvm'] as const) {
    const c = isolationCost(level);
    assert.ok(c.description.length > 10);
  }
});

test('MicroVMSandboxProvider: has backend type', () => {
  const p = new MicroVMSandboxProvider();
  assert.equal(p.backend, 'docker');
});
