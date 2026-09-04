import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJson5, validateModuleJson5, validateBuildProfile, checkProjectSchemas } from '../schema.ts';
import { parseSdkVersion, compareSdk, capabilitiesFor } from '../apimatrix.ts';

/* ---------------- lenient JSON5 ---------------- */

test('parseJson5: comments + trailing commas + single quotes tolerated; broken JSON reported', () => {
  const o = parseJson5(`{
    // line comment
    "a": 1, /* block comment */
    'b': 'x',
    "list": [1, 2, 3,],
  }`) as { a: number; b: string; list: number[] };
  assert.equal(o.a, 1);
  assert.equal(o.b, 'x');
  assert.deepEqual(o.list, [1, 2, 3]);
  assert.throws(() => parseJson5('{ "a": '));
});

/* ---------------- module.json5 validation ---------------- */

test('module.json5: valid entry passes; missing mainElement / bad type / empty deviceTypes flagged', () => {
  const ok = { module: { name: 'entry', type: 'entry', mainElement: 'EntryAbility', deviceTypes: ['phone'] } };
  assert.equal(validateModuleJson5(ok, 'm.json5').length, 0);
  const noMain = { module: { name: 'entry', type: 'entry', deviceTypes: ['phone'] } };
  const issues1 = validateModuleJson5(noMain, 'm.json5');
  assert.ok(issues1.some((i) => i.field === 'module.mainElement'));
  const badType = { module: { name: 'x', type: 'plugin', mainElement: 'A', deviceTypes: ['phone'] } };
  const issues2 = validateModuleJson5(badType, 'm.json5');
  assert.ok(issues2.some((i) => i.field === 'module.type' && /entry\/feature\/har\/shared/.test(i.problem)));
  const noDevices = { module: { name: 'entry', type: 'entry', mainElement: 'A', deviceTypes: [] } };
  assert.ok(validateModuleJson5(noDevices, 'm.json5').some((i) => i.field === 'module.deviceTypes'));
  // har module: entry-only requirements do not apply
  const har = { module: { name: 'uikit', type: 'har' } };
  assert.equal(validateModuleJson5(har, 'm.json5').length, 0);
});

/* ---------------- build-profile validation ---------------- */

test('build-profile: root needs app.products + modules with SDK versions; module needs targets', () => {
  const rootOk = { app: { products: [{ name: 'default', compatibleSdkVersion: '6.1.1(24)' }], signingConfigs: [] }, modules: [{ name: 'entry', srcPath: './entry', targets: [] }] };
  assert.equal(validateBuildProfile(rootOk, 'bp', 'root').length, 0);
  const noSdk = { app: { products: [{ name: 'default' }] }, modules: [{ name: 'entry' }] };
  assert.ok(validateBuildProfile(noSdk, 'bp', 'root').some((i) => i.field.includes('compatibleSdkVersion')));
  const modOk = { apiType: 'stageMode', targets: [{ name: 'default' }] };
  assert.equal(validateBuildProfile(modOk, 'bp', 'module').length, 0);
  const badApi = { apiType: 'faMode', targets: [{ name: 'default' }] };
  assert.ok(validateBuildProfile(badApi, 'bp', 'module').some((i) => i.field === 'apiType'));
});

/* ---------------- project-wide check (scaffold real shape) ---------------- */

test('checkProjectSchemas: valid scaffold passes; corrupted module.json5 caught with the exact field', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmh-schema-'));
  await mkdir(join(root, 'entry', 'src', 'main'), { recursive: true });
  await writeFile(join(root, 'build-profile.json5'),
    '{\n  "app": { "products": [ { "name": "default", "compatibleSdkVersion": "6.1.1(24)" } ] },\n  "modules": [ { "name": "entry", "srcPath": "./entry", "targets": [] } ]\n}\n', 'utf8');
  await writeFile(join(root, 'entry', 'build-profile.json5'),
    '{\n  "apiType": "stageMode",\n  "targets": [ { "name": "default" } ]\n}\n', 'utf8');
  await writeFile(join(root, 'entry', 'src', 'main', 'module.json5'),
    '{\n  "module": {\n    "name": "entry",\n    "type": "entry",\n    "mainElement": "EntryAbility",\n    "deviceTypes": [ "phone" ]\n  }\n}\n', 'utf8');
  const ok = await checkProjectSchemas(root);
  assert.equal(ok.issues.length, 0);
  assert.equal(ok.checked, 3);

  // corrupt: type typo + unparseable second file
  await writeFile(join(root, 'entry', 'src', 'main', 'module.json5'),
    '{\n  "module": {\n    "name": "entry",\n    "type": "enty",\n    "mainElement": "EntryAbility",\n    "deviceTypes": [ "phone" ]\n  }\n}\n', 'utf8');
  await mkdir(join(root, 'broken', 'src', 'main'), { recursive: true });
  await writeFile(join(root, 'broken', 'src', 'main', 'module.json5'), '{ "module": { ', 'utf8');
  const bad = await checkProjectSchemas(root);
  assert.ok(bad.issues.some((i) => i.field === 'module.type'));
  assert.ok(bad.issues.some((i) => i.field === '(parse)'));
  await rm(root, { recursive: true, force: true });
});

/* ---------------- API matrix ---------------- */

test('parseSdkVersion: legacy "(24)" shape vs 26+ SemVer; junk throws', () => {
  const v1 = parseSdkVersion('6.1.1(24)');
  assert.equal(v1.shape, 'legacy');
  assert.equal(v1.apiLevel, 24);
  const v2 = parseSdkVersion('26.0.0');
  assert.equal(v2.shape, 'semver');
  assert.equal(v2.apiLevel, 26);
  const v3 = parseSdkVersion('5.0.5(17)');
  assert.equal(v3.apiLevel, 17);
  assert.throws(() => parseSdkVersion('v6.1'));
  assert.throws(() => parseSdkVersion('6.1.1(24)extra'));
});

test('compareSdk + capabilitiesFor: ordering and matrix gating across the 26.0.0 switch', () => {
  assert.equal(compareSdk('5.0.5(17)', '6.1.1(24)'), -1);
  assert.equal(compareSdk('6.1.1(24)', '5.0.5(17)'), 1);
  assert.equal(compareSdk('26.0.0', '6.1.1(24)'), 1);
  assert.equal(compareSdk('26.0.0', '26.0.0'), 0);
  const on25 = capabilitiesFor('6.1.1(24)');
  assert.equal(on25.find((c) => c.id === 'shared-module')?.available, true);
  assert.equal(on25.find((c) => c.id === 'semver-numbering')?.available, false);
  const on26 = capabilitiesFor('26.0.0');
  assert.equal(on26.find((c) => c.id === 'semver-numbering')?.available, true);
  // everything still sorts available-first
  assert.equal(on26[0].available, true);
});
