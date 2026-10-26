/** 0.23.40 一致性补齐:cli/release-notes.json + website 四文件。 */
import { readFileSync, writeFileSync } from 'node:fs';

const V = '0.23.40';
const note = '执行器挂死根修（interrupt 信号贯穿飞行中的模型调用 + 5s kill 兜底 + 竞态锁存——空壳会话永久 busy 不再;953/953 零回退,复现实证 busy 0s 清除）';

// 1) release-notes.json: {notes:[{v,date,note}]} 头插
const rnPath = 'packages/cli/release-notes.json';
const rn = JSON.parse(readFileSync(rnPath, 'utf8'));
if (!rn.notes.some((n) => n.v === V)) {
  rn.notes.unshift({ v: V, date: '2026-10-26', note });
  writeFileSync(rnPath, JSON.stringify(rn, null, 2) + '\n', 'utf8');
  console.log('release-notes: 0.23.40 已插入');
}

// 2) website 四文件:0.23.39 → 0.23.40(数字与版本串替换;测试计数 946→953)
for (const f of ['website/llms.txt', 'website/llms-full.txt', 'website/index.html', 'website/faq.html']) {
  let t = readFileSync(f, 'utf8');
  const before = t;
  t = t.split('0.23.39').join(V);
  if (t !== before) {
    writeFileSync(f, t, 'utf8');
    console.log(f, ': 版本串已更新');
  } else {
    console.log(f, ': 无 0.23.39 字样(检查)', t.includes(V) ? '已含' .concat(V) : '需人工');
  }
}
// 测试计数同步(llms/index 中的 946 个单元测试)
for (const f of ['website/llms.txt', 'website/index.html', 'website/llms-full.txt']) {
  let t = readFileSync(f, 'utf8');
  const n = t.replace(/946 个单元测试/g, '953 个单元测试').replace(/946 unit tests/g, '953 unit tests');
  if (n !== t) { writeFileSync(f, n, 'utf8'); console.log(f, ': 测试计数 946→953'); }
}
