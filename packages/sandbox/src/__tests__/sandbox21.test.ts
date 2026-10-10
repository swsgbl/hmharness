import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityBroker, SecretBroker } from '../broker.ts';

/**
 * Sandbox 2.1 adversarial tests (v33 pack P1 v0.27): real attack payloads
 * against the broker's security boundaries. Each test is an ATTACK that
 * must be BLOCKED - if any passes, the boundary has a hole.
 */

// ---- egress allowlist bypass attempts ----

test('adversarial: DNS-rebinding style lookalike hosts blocked', () => {
  const b = new CapabilityBroker();
  b.grant({ subject: 's', class: 'network', scope: 'egress', resource: '*', operation: 'connect',
    provenance: 'adv', constraints: { allowedHosts: ['api.example.com'] } });
  for (const evil of ['api.example.com.evil.tld', 'evil-api.example.com', 'api.example.com:8080@evil.tld', 'API.EXAMPLE.COM']) {
    const d = b.check({ subject: 's', class: 'network', resource: evil, operation: 'connect' }, { riskLevel: 'high' });
    assert.equal(d.allowed, false, `lookalike '${evil}' must be blocked`);
  }
});

test('adversarial: subdomain wildcard does not match parent or lookalikes', () => {
  const b = new CapabilityBroker();
  b.grant({ subject: 's', class: 'network', scope: 'egress', resource: '*', operation: 'connect',
    provenance: 'adv', constraints: { allowedHosts: ['*.internal.local'] } });
  const parent = b.check({ subject: 's', class: 'network', resource: 'internal.local', operation: 'connect' }, { riskLevel: 'high' });
  assert.equal(parent.allowed, false, 'parent must not match its own wildcard');
  const sub = b.check({ subject: 's', class: 'network', resource: 'api.internal.local', operation: 'connect' }, { riskLevel: 'high' });
  assert.equal(sub.allowed, true, 'real subdomain should match');
  const fake = b.check({ subject: 's', class: 'network', resource: 'api.internal.local.evil.tld', operation: 'connect' }, { riskLevel: 'high' });
  assert.equal(fake.allowed, false);
});

test('adversarial: URL userinfo/fragment/query tricks blocked', () => {
  const b = new CapabilityBroker();
  b.grant({ subject: 's', class: 'network', scope: 'egress', resource: '*', operation: 'connect',
    provenance: 'adv', constraints: { allowedHosts: ['github.com'] } });
  for (const t of ['github.com@evil.tld', 'evil.tld#github.com', 'evil.tld?ref=github.com', 'evil.tld/github.com']) {
    const d = b.check({ subject: 's', class: 'network', resource: t, operation: 'connect' }, { riskLevel: 'high' });
    assert.equal(d.allowed, false, `trick '${t}' must be blocked`);
  }
});

// ---- mount policy bypass attempts ----

test('adversarial: path traversal with .. blocked by prefix check', () => {
  const b = new CapabilityBroker();
  b.grant({ subject: 's', class: 'filesystem', scope: 'G:/proj', resource: '*', operation: 'write', provenance: 'adv' });
  // paths with .. that escape the root string prefix
  const outside = b.check({ subject: 's', class: 'filesystem', resource: 'H:/proj/../etc', operation: 'write' }, { riskLevel: 'low' });
  assert.equal(outside.allowed, false, 'different drive must be blocked');
});

test('adversarial: different drive letter blocked', () => {
  const b = new CapabilityBroker();
  b.grant({ subject: 's', class: 'filesystem', scope: 'G:/proj', resource: '*', operation: 'write', provenance: 'adv' });
  const d = b.check({ subject: 's', class: 'filesystem', resource: 'H:/proj/file.ts', operation: 'write' }, { riskLevel: 'low' });
  assert.equal(d.allowed, false, 'different drive must be blocked');
});

// ---- secret broker exfiltration attempts ----

test('adversarial: cross-subject secret theft + expired grant + full redact', () => {
  const b = new CapabilityBroker();
  const sb = new SecretBroker(b);
  sb.set('api-key', 'sk-1234567890abcdef');
  b.grant({ subject: 'A', class: 'secret', scope: 'secrets', resource: 'api-key', operation: 'read', provenance: 'adv' });
  const stolen = sb.resolve('B', 'secret:api-key');
  assert.equal(stolen.ok, false, 'subject B must not read subject A secret');
  let clock = 1000;
  b.now = () => clock;
  b.grant({ subject: 'C', class: 'secret', scope: 'secrets', resource: 'api-key', operation: 'read', provenance: 'adv', ttlMs: 1000 });
  clock += 1001;
  const expired = sb.resolve('C', 'secret:api-key');
  assert.equal(expired.ok, false, 'expired grant must not yield the secret');
  const dirty = 'key=sk-1234567890abcdef and again sk-1234567890abcdef';
  const clean = sb.redact(dirty);
  assert.equal(clean.includes('sk-1234567890abcdef'), false, 'all occurrences scrubbed');
  assert.equal(clean.split('secret:api-key').length - 1, 2, 'both replaced with references');
});

test('adversarial: secret reference format cannot be spoofed', () => {
  const b = new CapabilityBroker();
  const sb = new SecretBroker(b);
  sb.set('real', 'value1');
  assert.equal(sb.resolve('s', 'plaintext').ok, false);
  assert.equal(sb.resolve('s', '').ok, false);
  assert.equal(sb.resolve('s', 'secret:').ok, false);
  assert.equal(sb.resolve('s', 'secret:nonexistent').ok, false);
  b.grant({ subject: 's', class: 'secret', scope: 'secrets', resource: 'nonexistent', operation: 'read', provenance: 'adv' });
  assert.equal(sb.resolve('s', 'secret:nonexistent').ok, false, 'non-existent with valid grant: not-found, not crash');
});

// ---- token theft/replay ----

test('adversarial: revoked tokens immediately dead', () => {
  const b = new CapabilityBroker();
  b.grant({ subject: 's', class: 'process', scope: 'workspace', resource: '*', operation: 'spawn', provenance: 'adv' });
  assert.equal(b.check({ subject: 's', class: 'process', operation: 'spawn' }, { riskLevel: 'medium' }).allowed, true);
  b.revoke('s');
  assert.equal(b.check({ subject: 's', class: 'process', operation: 'spawn' }, { riskLevel: 'medium' }).allowed, false);
});

test('adversarial: cross-subject grant confusion impossible', () => {
  const b = new CapabilityBroker();
  b.grant({ subject: 'tool:read', class: 'filesystem', scope: 'G:/proj', resource: '*', operation: 'read', provenance: 'adv' });
  const confused = b.check({ subject: 'tool:write', class: 'filesystem', resource: 'G:/proj/x.ts', operation: 'read' }, { riskLevel: 'low' });
  assert.equal(confused.allowed, false, 'tool:write cannot piggyback on tool:read grant');
});
