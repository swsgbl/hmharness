import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseBuildFailure, firstErrorBlock } from '../builddoctor.ts';
import { profileProject } from '../profile.ts';
import { scaffoldProject } from '../project.ts';

const mk = (sig: string) => `\nBUILD FAILED in 12s\n${sig}\n... 40 more lines of stack trace ...\n`;

test('doctor: classifies the seven known failure classes', () => {
  const cases: Array<[string, string]> = [
    ['Error: Invalid value of DEVECO_SDK_HOME.', 'sdk-home'],
    ['ERROR: no signing config matched product default (keystore missing)', 'signing'],
    ['ohpm ERROR: Failed to install dependencies 404 @ohos/axios', 'ohpm-deps'],
    ['Cannot find module .../hvigor/bin: NODE_HOME not set', 'hvigor-env'],
    ["ERROR: ArkTS Compiler: ERROR: ArkTS-1123 in Index.ets", 'arkts-source'],
    ['A problem occurred evaluating project: parse module.json5 Expected ,', 'config'],
    ['fetch failed: network timeout registry.npmjs.org', 'network'],
  ];
  for (const [sig, kind] of cases) {
    const d = diagnoseBuildFailure(mk(sig));
    assert.ok(d, `should classify: ${sig}`);
    assert.equal(d!.kind, kind);
    assert.ok(d!.fix.length > 30, 'each class carries a concrete fix');
  }
});

test('doctor: unknown signature returns null (never hidden), firstErrorBlock extracts the block', () => {
  assert.equal(diagnoseBuildFailure(mk('something entirely novel happened')), null);
  const log = 'hvigor info\nhvigor info\nERROR: ArkTS-100 in Foo.ets:42 expected semicolon\nmore lines';
  assert.match(firstErrorBlock(log), /ArkTS-100 in Foo\.ets:42/);
});

test('profile: scaffolded project inventory is accurate (quality-trio base layer)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-profile-'));
  const root = join(home, 'proj');
  await scaffoldProject(root, { name: 'Demo', bundleId: 'com.example.demo', pages: ['Login'], modules: [{ name: 'uikit', type: 'har' }] });
  const p = await profileProject(root);
  assert.equal(p.bundleName, 'com.example.demo');
  assert.equal(p.modules.length, 2); // entry + uikit
  const entry = p.modules.find((m) => m.name === 'entry')!;
  assert.equal(entry.type, 'entry');
  assert.equal(entry.pages.length, 2); // Index + Login
  assert.ok(entry.abilities.includes('EntryAbility'));
  const har = p.modules.find((m) => m.name === 'uikit')!;
  assert.equal(har.type, 'har');
  assert.ok(p.hapDependencies.some((d) => d.startsWith('uikit@')));
  assert.equal(p.configIssues, 0); // fresh scaffold is schema-clean
  assert.ok(p.sourceFiles >= 4); // EntryAbility, Index, Login, uikit Index
  await rm(home, { recursive: true, force: true });
});
