/** tsc traceResolution:agent 解析 @hmharness/kernel 的实际类型文件。 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const cwd = 'C:/Users/hongfu/AppData/Local/Temp/hmh-ci-repro/packages/agent';
const r = spawnSync('npx', ['tsc', '-p', 'tsconfig.build.json', '--traceResolution'], { cwd, encoding: 'utf8', timeout: 300_000, maxBuffer: 128 * 1024 * 1024 });
const out = (r.stdout ?? '') + (r.stderr ?? '');
writeFileSync('C:/Users/hongfu/AppData/Local/Temp/trace.txt', out, 'utf8');
const lines = out.split('\n');
const hits = [];
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("Module name '@hmharness/kernel'")) {
    hits.push(lines.slice(i, i + 8).filter((l) => l.includes('Resolution for module') || l.includes('Resolved') || l.includes('File') || l.includes('types') || l.includes('exists')).join('\n'));
  }
}
writeFileSync('C:/Users/hongfu/AppData/Local/Temp/trace-hits.txt', hits.slice(0, 3).join('\n---\n'), 'utf8');
console.log('saved; hits:', hits.length);
