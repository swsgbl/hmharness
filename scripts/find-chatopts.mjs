/** 全 kernel 搜 ChatOptions 定义与 re-export。 */
import { readFileSync, readdirSync } from 'node:fs';
const walk = (d, acc) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = `${d}/${f.name}`; if (f.isDirectory()) walk(p, acc); else if (/\.(ts|d\.ts)$/.test(f.name) || f.name.endsWith('.ts')) acc.push(p); } return acc; };
for (const root of ['packages/kernel/src', 'packages/kernel/dist']) {
  for (const f of walk(root, [])) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (/interface ChatOptions|type ChatOptions|ChatOptions,|ChatOptions }|as ChatOptions/.test(l) && /ChatOptions/.test(l)) {
        if (/interface ChatOptions|type ChatOptions/.test(l) || /export/.test(l)) console.log(`${f}:${i + 1}: ${l.trim().slice(0, 100)}`);
      }
    });
  }
}
// agent 的 import 行
const runner = readFileSync('packages/agent/src/runner.ts', 'utf8').split('\n');
runner.forEach((l, i) => { if (l.includes('hmharness/kernel')) console.log(`runner.ts:${i + 1}: ${l.trim()}`); });
