import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complexityScore, decideTopology, extractCharacteristics } from '../topology.ts';

test('complexityScore: simple task is low', () => {
  const c = { wordCount: 5, fileTypes: 0, requiresBuild: false, requiresTest: false, requiresDeploy: false, multiModule: false, estimatedSteps: 1, externalDependencies: false };
  assert.ok(complexityScore(c) < 20);
});

test('complexityScore: complex task is high', () => {
  const c = { wordCount: 100, fileTypes: 4, requiresBuild: true, requiresTest: true, requiresDeploy: true, multiModule: true, estimatedSteps: 8, externalDependencies: true };
  assert.ok(complexityScore(c) >= 70);
});

test('decideTopology: simple -> single', () => {
  const c = { wordCount: 5, fileTypes: 0, requiresBuild: false, requiresTest: false, requiresDeploy: false, multiModule: false, estimatedSteps: 1, externalDependencies: false };
  const d = decideTopology(c);
  assert.equal(d.mode, 'single');
  assert.equal(d.roles.length, 1);
});

test('decideTopology: medium -> dual', () => {
  const c = { wordCount: 30, fileTypes: 2, requiresBuild: true, requiresTest: false, requiresDeploy: false, multiModule: false, estimatedSteps: 3, externalDependencies: false };
  const d = decideTopology(c);
  assert.equal(d.mode, 'dual');
  assert.ok(d.roles.includes('reviewer'));
});

test('decideTopology: very complex -> team', () => {
  const c = { wordCount: 100, fileTypes: 5, requiresBuild: true, requiresTest: true, requiresDeploy: true, multiModule: true, estimatedSteps: 8, externalDependencies: true };
  const d = decideTopology(c);
  assert.equal(d.mode, 'team');
  assert.ok(d.roles.includes('architect'));
  assert.ok(d.roles.includes('judge'));
});

test('extractCharacteristics: detects build/test', () => {
  const c = extractCharacteristics('build the project and run tests');
  assert.equal(c.requiresBuild, true);
  assert.equal(c.requiresTest, true);
  assert.equal(c.requiresDeploy, false);
});

test('extractCharacteristics: detects file types', () => {
  const c = extractCharacteristics('modify src/main.ts and update package.json');
  assert.ok(c.fileTypes >= 2);
});

test('extractCharacteristics: multi-module detection', () => {
  const c = extractCharacteristics('update the auth module and the payment module');
  assert.equal(c.multiModule, true);
});
