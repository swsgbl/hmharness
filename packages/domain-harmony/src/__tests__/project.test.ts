import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldProject, solidPng } from '../project.ts';

test('solidPng emits a structurally valid PNG', () => {
  const png = solidPng(96, [1, 2, 3, 255]);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 96); // width
  assert.equal(png.readUInt32BE(20), 96); // height
  assert.equal(png[25], 6); // RGBA
});

test('scaffoldProject wires pages and modules end-to-end', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hmh-proj-'));
  try {
    const r = await scaffoldProject(join(dir, 'AppT'), {
      name: 'AppT',
      pages: ['Login', 'Home'],
      modules: [
        { name: 'profile', type: 'feature' },
        { name: 'uikit', type: 'har' },
      ],
    });
    assert.match(r.bundleId, /com\.example\.appt/);

    const bp = await readFile(join(r.root, 'build-profile.json5'), 'utf8');
    assert.match(bp, /"name": "entry"/);
    assert.match(bp, /"name": "profile"/);
    assert.match(bp, /"name": "uikit"/);

    const pages = await readFile(join(r.root, 'entry/src/main/resources/base/profile/main_pages.json'), 'utf8');
    assert.match(pages, /pages\/Index/);
    assert.match(pages, /pages\/Login/);
    assert.match(pages, /pages\/Home/);

    const entryPkg = await readFile(join(r.root, 'entry/oh-package.json5'), 'utf8');
    assert.match(entryPkg, /"uikit": "file:\.\.\/uikit"/); // har wired into entry deps
    assert.doesNotMatch(entryPkg, /profile/); // feature modules are not deps

    const harHvigor = await readFile(join(r.root, 'uikit/hvigorfile.ts'), 'utf8');
    assert.match(harHvigor, /harTasks/);
    const featHvigor = await readFile(join(r.root, 'profile/hvigorfile.ts'), 'utf8');
    assert.match(featHvigor, /hapTasks/);

    const harMod = await readFile(join(r.root, 'uikit/src/main/module.json5'), 'utf8');
    assert.match(harMod, /"type": "har"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
