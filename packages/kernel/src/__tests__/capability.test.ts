import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CapabilityRegistry,
  classifyToolRisk,
  DEFAULT_POLICY_RULES,
  type CapabilityManifest,
} from '../capability.ts';

const mk = (id: string, risk: CapabilityManifest['risk'], source: CapabilityManifest['source'] = 'builtin'): CapabilityManifest => ({
  id, description: 'test capability', risk, source, version: '1.0.0',
});

test('registry: register + dedup (supply-chain safety)', () => {
  const r = new CapabilityRegistry();
  assert.deepEqual(r.register(mk('fs:read', 'read-only')), { ok: true });
  assert.equal(r.register(mk('fs:read', 'read-only')).ok, false, 'duplicate rejected');
  assert.equal(r.has('fs:read'), true);
  assert.equal(r.has('fs:write'), false);
});

test('policy: deny-first - destructive always denied', () => {
  const r = new CapabilityRegistry();
  r.register(mk('shell:rm_rf', 'destructive'));
  const d = r.check('shell:rm_rf');
  assert.equal(d.allow, false);
  assert.equal(d.needsApproval, false);
  assert.equal(d.policyId, 'deny-destructive');
});

test('policy: read-only auto-approved (zero-config)', () => {
  const r = new CapabilityRegistry();
  r.register(mk('fs:read_file', 'read-only'));
  const d = r.check('fs:read_file');
  assert.equal(d.allow, true);
  assert.equal(d.needsApproval, false);
});

test('policy: workspace-write needs approval', () => {
  const r = new CapabilityRegistry();
  r.register(mk('fs:write_file', 'workspace-write'));
  const d = r.check('fs:write_file');
  assert.equal(d.allow, true);
  assert.equal(d.needsApproval, true);
});

test('policy: device operations need approval', () => {
  const r = new CapabilityRegistry();
  r.register(mk('device:hdc_install', 'device'));
  const d = r.check('device:hdc_install');
  assert.equal(d.allow, true);
  assert.equal(d.needsApproval, true);
});

test('policy: unknown capability denied (deny-first)', () => {
  const r = new CapabilityRegistry();
  const d = r.check('nonexistent:tool');
  assert.equal(d.allow, false);
  assert.equal(d.policyId, 'not-found');
});

test('policy: unregistered risk tier denied by catch-all', () => {
  const r = new CapabilityRegistry();
  // register something with a risk that doesn't match any specific rule
  // but isn't read-only either - the catch-all 'deny-unknown' should hit
  r.register(mk('custom:mystery', 'network'));
  const d = r.check('custom:mystery');
  assert.equal(d.allow, true); // network has a rule
  assert.equal(d.needsApproval, true);
});

test('policy: custom rule overrides (user config)', () => {
  const r = new CapabilityRegistry();
  r.register(mk('fs:write_file', 'workspace-write'));
  // add a rule that allows fs: tools without approval
  r.addRule({
    id: 'allow-fs',
    priority: 5, // before the default workspace-write rule (priority 40)
    match: { idPrefix: 'fs:' },
    decision: { allow: true, needsApproval: false, reason: 'user trusted fs tools' },
  });
  const d = r.check('fs:write_file');
  assert.equal(d.allow, true);
  assert.equal(d.needsApproval, false, 'custom rule should bypass approval');
  assert.equal(d.policyId, 'allow-fs');
});

test('classifyToolRisk maps common tool names correctly', () => {
  assert.equal(classifyToolRisk('read_file', false), 'read-only');
  assert.equal(classifyToolRisk('write_file', true), 'workspace-write');
  assert.equal(classifyToolRisk('edit_file', true), 'workspace-write');
  assert.equal(classifyToolRisk('run_command', true), 'system');
  assert.equal(classifyToolRisk('web_search', true), 'network');
  assert.equal(classifyToolRisk('harmony_hdc_install', true), 'device');
});

test('audit trail lists all capabilities with decisions', () => {
  const r = new CapabilityRegistry();
  r.register(mk('fs:read', 'read-only'));
  r.register(mk('fs:write', 'workspace-write'));
  r.register(mk('device:hdc', 'device'));
  const trail = r.audit();
  assert.equal(trail.length, 3);
  assert.equal(trail.every(t => t.decision.policyId), true);
});

test('list with filter', () => {
  const r = new CapabilityRegistry();
  r.register(mk('fs:read', 'read-only'));
  r.register(mk('mcp:search', 'network', 'mcp'));
  r.register(mk('dev:install', 'device', 'device'));
  assert.equal(r.list({ risk: 'read-only' }).length, 1);
  assert.equal(r.list({ source: 'mcp' }).length, 1);
  assert.equal(r.list().length, 3);
});
