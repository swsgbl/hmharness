import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DockerSandboxProvider, LocalSandboxProvider, createSandboxProvider, dockerStatus } from '../provider.ts';

test('LocalSandboxProvider is always available', async () => {
  const p = new LocalSandboxProvider();
  assert.equal(await p.isAvailable(), true);
  assert.equal(p.backend, 'local');
});

test('DockerSandboxProvider detects Docker availability', async () => {
  const p = new DockerSandboxProvider();
  const avail = await p.isAvailable();
  assert.equal(typeof avail, 'boolean');
  assert.equal(p.backend, 'docker');
});

test('createSandboxProvider returns a provider', async () => {
  const p = await createSandboxProvider('local');
  assert.equal(p.backend, 'local');
});

test('LocalSandboxProvider exec runs commands', async () => {
  const p = new LocalSandboxProvider();
  const r = await p.exec('echo', ['hello'], {
    workdir: process.cwd(),
    limits: { timeoutMs: 5000 },
  });
  assert.equal(r.exitCode, 0);
  assert.ok(r.stdout.includes('hello'));
  assert.equal(r.backend, 'local');
});

test('dockerStatus reports correctly when Docker unavailable', () => {
  const s = dockerStatus(false, 'node:22-alpine');
  assert.ok(s.includes('not available'));
  assert.ok(s.includes('local sandbox'));
});

test('dockerStatus reports correctly when Docker available', () => {
  const s = dockerStatus(true, 'node:22-alpine');
  assert.ok(s.includes('available'));
  assert.ok(s.includes('containers'));
});

test('SandboxResult has required fields', async () => {
  const p = new LocalSandboxProvider();
  const r = await p.exec('echo', ['test'], {
    workdir: process.cwd(),
    limits: { timeoutMs: 5000 },
  });
  assert.ok('exitCode' in r);
  assert.ok('stdout' in r);
  assert.ok('stderr' in r);
  assert.ok('durationMs' in r);
  assert.ok('backend' in r);
});
