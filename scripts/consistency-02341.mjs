/** 0.23.41 一致性补齐:cli/release-notes.json + website 四文件 + 测试计数。 */
import { readFileSync, writeFileSync } from 'node:fs';

const V = '0.23.41';
const note = '/evolve 401 根修（密钥轮换后化石 provider 字段击穿 TUI 快路径——loadConfig 派生治愈全部 legacy 消费方 + /bench /evolve 目的路由解析;954/954 零回退）';

// 1) release-notes.json: {notes:[{v,date,note}]} 头插
const rnPath = 'packages/cli/release-notes.json';
const rn = JSON.parse(readFileSync(rnPath, 'utf8'));
if (!rn.notes.some((n) => n.v === V)) {
  rn.notes.unshift({ v: V, date: '2026-10-27', note });
  writeFileSync(rnPath, JSON.stringify(rn, null, 2) + '\n', 'utf8');
  console.log(`release-notes: ${V} 已插入`);
}

// 2) website 四文件:0.23.40 → 0.23.41
for (const f of ['website/llms.txt', 'website/llms-full.txt', 'website/index.html', 'website/faq.html']) {
  let t = readFileSync(f, 'utf8');
  const before = t;
  t = t.split('0.23.40').join(V);
  if (t !== before) {
    writeFileSync(f, t, 'utf8');
    console.log(f, ': 版本串已更新');
  } else {
    console.log(f, ': 无 0.23.40 字样(检查)', t.includes(V) ? `已含${V}` : '需人工');
  }
}
// 3) 测试计数同步 953 → 954
for (const f of ['website/llms.txt', 'website/index.html', 'website/llms-full.txt']) {
  let t = readFileSync(f, 'utf8');
  const n = t.replace(/953 个单元测试/g, '954 个单元测试').replace(/953 unit tests/g, '954 unit tests');
  if (n !== t) { writeFileSync(f, n, 'utf8'); console.log(f, ': 测试计数 953→954'); }
}
