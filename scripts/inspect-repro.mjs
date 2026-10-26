/** 查复现环境的 kernel 声明与 agent tsconfig。 */
import { readFileSync } from 'node:fs';
const root = 'C:/Users/hongfu/AppData/Local/Temp/hmh-ci-repro';
const d = readFileSync(`${root}/packages/kernel/dist/provider.d.ts`, 'utf8');
console.log('repro dist signal:', d.includes('signal'));
const i = d.indexOf('ChatOptions');
console.log(d.slice(i, i + 240));
console.log('--- agent tsconfig.build.json ---');
console.log(readFileSync(`${root}/packages/agent/tsconfig.build.json`, 'utf8'));
