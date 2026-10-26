/** agent ChatOptions 用法与 517 行上下文。 */
import { readFileSync, readdirSync } from 'node:fs';
const walk = (d, acc) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = `${d}/${f.name}`; if (f.isDirectory()) walk(p, acc); else if (f.name.endsWith('.ts')) acc.push(p); } return acc; };
for (const f of walk('packages/agent/src', [])) {
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((l, i) => { if (l.includes('ChatOptions')) console.log(`${f}:${i + 1}: ${l.trim().slice(0, 90)}`); });
}
console.log('--- runner.ts 510-522 ---');
const t = readFileSync('packages/agent/src/runner.ts', 'utf8').split('\n');
console.log(t.slice(509, 522).map((l, i) => `${510 + i}: ${l}`).join('\n'));
