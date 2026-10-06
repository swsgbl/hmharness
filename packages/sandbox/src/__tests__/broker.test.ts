import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityBroker } from '../broker.ts';

test('broker: deny-by-default with the reason stated', () => {
  const b = new CapabilityBroker();
  const d = b.check({ subject: 'tool:read_file', class: 'filesystem', resource: 'G:/proj/x.ts' }, { riskLevel: 'low' });
  assert.equal(d.allowed, false);
  assert.match(d.reason, /deny-by-default/);
  assert.equal(d.tier, 'worker', 'low-risk read-only filesystem = worker tier');
});

test('broker: grant -> allow -> expiry -> deny again', () => {
  const b = new CapabilityBroker();
  let clock = 1_000_000;
  b.now = () => clock;
  b.grant({ subject: 'tool:write_file', class: 'filesystem', scope: 'workspace-root', resource: 'G:/proj/x.ts', operation: 'write', provenance: 'test: explicit workspace write' });
  const ok = b.check({ subject: 'tool:write_file', class: 'filesystem', resource: 'G:/proj/x.ts', operation: 'write' }, { riskLevel: 'low' });
  assert.equal(ok.allowed, true);
  assert.match(ok.reason, /provenance: test: explicit workspace write/);
  clock += 60 * 60 * 1000 + 1; // past the 1h default TTL
  const expired = b.check({ subject: 'tool:write_file', class: 'filesystem', resource: 'G:/proj/x.ts', operation: 'write' }, { riskLevel: 'low' });
  assert.equal(expired.allowed, false, 'expired tokens are reaped on check');
});

test('broker: the RLM rule - worker tier never holds network/secret/process/device, tokens or not', () => {
  const b = new CapabilityBroker();
  b.grant({ subject: 'rlm-eval', class: 'secret', scope: 'host', resource: '*', operation: 'read', provenance: 'mistaken grant' });
  b.grant({ subject: 'rlm-eval', class: 'network', scope: 'host', resource: '*', operation: 'connect', provenance: 'mistaken grant' });
  const secret = b.check({ subject: 'rlm-eval', class: 'secret', operation: 'read' }, { riskLevel: 'low', executionContext: 'rlm-worker' });
  const net = b.check({ subject: 'rlm-eval', class: 'network', operation: 'connect' }, { riskLevel: 'low', executionContext: 'rlm-worker' });
  assert.equal(secret.allowed, false);
  assert.match(secret.reason, /RLM no-host-capability/);
  assert.equal(net.allowed, false);
});

test('broker: the risk ladder composes recommendedIsolation + escalation rules', () => {
  const b = new CapabilityBroker();
  const req = { subject: 's', class: 'filesystem' as const };
  assert.equal(b.tierFor(req, { riskLevel: 'critical' }), 'microvm');
  assert.equal(b.tierFor(req, { riskLevel: 'high', taskDurationMs: 120_000 }), 'microvm', 'high + long-running escalates to microvm');
  assert.equal(b.tierFor({ ...req, class: 'network' }, { riskLevel: 'low' }), 'container', 'any network = container minimum');
  assert.equal(b.tierFor({ ...req, operation: 'write' }, { riskLevel: 'low' }), 'process');
  assert.equal(b.tierFor(req, { riskLevel: 'medium' }), 'process');
});

test('broker: unprovenanced grants refuse; revoke by subject; audit trail and deny hook', () => {
  const b = new CapabilityBroker();
  assert.throws(() => b.grant({ subject: 'x', class: 'device', scope: 'host', resource: 'screen', operation: 'execute' } as never), /provenance/);
  const denied: string[] = [];
  b.onDeny = (subject, cls) => denied.push(`${subject}:${cls}`);
  b.grant({ subject: 'tool:shell', class: 'process', scope: 'workspace', resource: '*', operation: 'spawn', provenance: 'test' });
  b.check({ subject: 'other', class: 'process', operation: 'spawn' }, { riskLevel: 'medium' });
  assert.deepEqual(denied, ['other:process'], 'deny hook fires with subject+class');
  assert.equal(b.revoke('tool:shell'), 1);
  const after = b.check({ subject: 'tool:shell', class: 'process', operation: 'spawn' }, { riskLevel: 'medium' });
  assert.equal(after.allowed, false, 'revoked tokens deny');
  const trail = b.auditTrail();
  assert.ok(trail.length >= 2);
  assert.ok(trail.every((e) => typeof e.reason === 'string' && e.reason.length > 0));
});
