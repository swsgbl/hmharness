import { writeFileSync } from 'node:fs';
import { scaffoldProject, solidPng } from '../packages/domain-harmony/src/project.ts';
const png = solidPng(96, [31, 111, 235, 255]);
console.log('png bytes:', png.length, 'sig ok:', png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a');
writeFileSync('.tmp-icon.png', png);
const r = await scaffoldProject('.tmp-e2e/HelloHm3', { name: 'HelloHm' });
console.log('scaffolded:', r.root, r.bundleId, r.files, 'files');
