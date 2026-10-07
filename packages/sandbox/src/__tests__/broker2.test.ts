import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityBroker, SecretBroker } from '../broker.ts';

test('sandbox 2.0: network egress allowlist denies hosts outside the grant', () => {
  const b = new CapabilityBroker();
  b.grant({
    subject: 'tool:web_fetch', class: 'network', scope: 'egress', resource: '*',
    operation: 'connect', provenance: 'test: allowlist grant',
    constraints: { allowedHosts: ['registry.npmjs.org', 'github.com', '*.example.org'] },
  });
  const ok = b.check({ subject: 'tool:web_fetch', class: 'network', resource: 'registry.npmjs.org', operation: 'connect' }, { riskLevel: 'high' });
  assert.equal(ok.allowed, true);
  const sub = b.check({ subject: 'tool:web_fetch', class: 'network', resource: 'api.sub.example.org', operation: 'connect' }, { riskLevel: 'high' });
  assert.equal(sub.allowed, true, 'suffix wildcard matches subdomains');
  const bad = b.check({ subject: 'tool:web_fetch', class: 'network', resource: 'evil.tld', operation: 'connect' }, { riskLevel: 'high' });
  assert.equal(bad.allowed, false);
  assert.match(bad.reason, /egress denied: 'evil\.tld'/);
});

test('sandbox 2.0: filesystem mount policy roots reads and writes to the scope subtree', () => {
  const b = new CapabilityBroker();
  b.grant({
    subject: 'tool:edit_file', class: 'filesystem', scope: 'G:/proj', resource: '*',
    operation: 'write', provenance: 'test: workspace grant',
  });
  const inside = b.check({ subject: 'tool:edit_file', class: 'filesystem', resource: 'G:/proj/src/x.ts', operation: 'write' }, { riskLevel: 'low' });
  assert.equal(inside.allowed, true);
  const root = b.check({ subject: 'tool:edit_file', class: 'filesystem', resource: 'G:/proj', operation: 'write' }, { riskLevel: 'low' });
  assert.equal(root.allowed, true, 'the root itself is in scope');
  const outside = b.check({ subject: 'tool:edit_file', class: 'filesystem', resource: 'C:/Windows/system32/config', operation: 'write' }, { riskLevel: 'low' });
  assert.equal(outside.allowed, false);
  assert.match(outside.reason, /mount policy/);
  // backslashes are normalized - a Windows-style inside path still passes
  const win = b.check({ subject: 'tool:edit_file', class: 'filesystem', resource: 'G:\\proj\\src\\y.ts', operation: 'write' }, { riskLevel: 'low' });
  assert.equal(win.allowed, true);
  // host scope is the explicit escape hatch (auditable, never silent)
  b.grant({ subject: 'tool:admin', class: 'filesystem', scope: 'host', resource: '*', operation: 'write', provenance: 'test: explicit host' });
  const host = b.check({ subject: 'tool:admin', class: 'filesystem', resource: 'C:/anywhere', operation: 'write' }, { riskLevel: 'critical' });
  assert.equal(host.allowed, true);
});

test('secret broker: references everywhere, values only under a live grant', () => {
  const b = new CapabilityBroker();
  const sb = new SecretBroker(b);
  const ref = sb.set('npm-token', 'npm_SUPERSECRETVALUE');
  assert.equal(ref, 'secret:npm-token');
  // no grant -> deny by default
  const denied = sb.resolve('tool:publish', ref);
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /deny-by-default/);
  // grant -> value
  b.grant({ subject: 'tool:publish', class: 'secret', scope: 'secrets', resource: 'npm-token', operation: 'read', provenance: 'test: publish grant', ttlMs: 60_000 });
  const ok = sb.resolve('tool:publish', ref);
  assert.equal(ok.ok, true);
  assert.equal((ok as { value: string }).value, 'npm_SUPERSECRETVALUE');
  // another subject cannot read it
  const other = sb.resolve('tool:other', ref);
  assert.equal(other.ok, false);
  // redact scrubs values from any text
  const dirty = 'curl -H "Authorization: Bearer npm_SUPERSECRETVALUE" https://x';
  assert.equal(sb.redact(dirty).includes('npm_SUPERSECRETVALUE'), false);
  assert.equal(sb.redact(dirty).includes('secret:npm-token'), true);
  // non-references refuse honestly
  assert.equal(sb.resolve('tool:publish', 'plaintext').ok, false);
});
