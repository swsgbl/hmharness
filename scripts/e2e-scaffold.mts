/** Parametric scaffold E2E: complex project -> real hvigor build. */
import { scaffoldProject, solidPng } from '../packages/domain-harmony/src/project.ts';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { harmonyBuild } from '../packages/domain-harmony/src/index.ts';
import { writeFileSync } from 'node:fs';
const png = solidPng(96, [31, 111, 235, 255]);
writeFileSync('.tmp-icon.png', png);
const root = join(tmpdir(), 'hmh-scaffold-e2e', 'AppX');
const r = await scaffoldProject(root, {
  name: 'AppX',
  pages: ['Login', 'Home'],
  modules: [
    { name: 'profile', type: 'feature' },
    { name: 'uikit', type: 'har' },
  ],
});
console.log('scaffolded:', r.root, r.bundleId, r.files, 'files');
const b = await harmonyBuild.execute({ project: root }, { cwd: root, home: join(homedir(), '.hmharness') });
console.log(b.output.split('\n').slice(0, 3).join('\n'));
console.log('isError:', b.isError === true);
