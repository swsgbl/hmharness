/** 0.23.40 发版准备:CHANGELOG 条目 + 16 包版本号。 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const entry = `## [0.23.40] - 2026-10-26

执行器挂死根修（桌面/鸿蒙客户端实测三次实发的"空壳会话永久 busy"）：①**根因**——busy 仅在任务子进程 exit 时清除，/api/interrupt 只向 stdin 写 abort，而该信号不进入飞行中的 provider.chat（chat 自建 AbortController 只接 timeoutMs 计时器）；provider 以 keep-alive ping 挂起 SSE 流时 180s 流空闲保护被持续刷新 → chat 永不返回、子进程永不退出 → busy 永久 true、interrupt 返回 200 但无效（仅重启 web 守护可清）。②**三层修复（最小侵入）**——kernel: ChatOptions.signal 外部取消贯穿飞行中的 fetch 与流读取，abort 后立即失败不重试，loop 每次模型调用与 compaction 摘要均传递 signal；web: interrupt 同时拒绝停靠审批+写 abort，5s 宽限后同一子进程仍 busy 则 kill 兜底（exit→finish→busy 清）；busy 先于 spawn 置位造成的 interrupt 竞态丢失 → abortIntent 锁存、spawn 后补投。③**测试**——新增 interrupt-stuck（挂起 provider→interrupt→busy 清）与 interrupt-race（spawn 前中断竞态）两个测试文件；全量 953/953 零回退；scripts/repro-stuck.mjs 复现实测：修复前永久 busy，修复后 interrupt 后 busy 0s 清除。板级安装器 FALLBACK_PINS 同步 0.23.39（publish.cjs 常规）。

`;

// CHANGELOG 头部插入
let ch = readFileSync('CHANGELOG.md', 'utf8');
if (!ch.includes('[0.23.40]')) {
  ch = entry + ch;
  writeFileSync('CHANGELOG.md', ch, 'utf8');
  console.log('CHANGELOG: 0.23.40 条目已插入');
}

// 16 包版本号
const pkgsRoot = 'packages';
let bumped = 0;
for (const dir of readdirSync(pkgsRoot)) {
  const p = `${pkgsRoot}/${dir}/package.json`;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (j.version === '0.23.39') { j.version = '0.23.40'; writeFileSync(p, JSON.stringify(j, null, 2) + '\n', 'utf8'); bumped += 1; }
  } catch { /* 非包子目录 */ }
}
const rootP = JSON.parse(readFileSync('package.json', 'utf8'));
if (rootP.version === '0.23.39') { rootP.version = '0.23.40'; writeFileSync('package.json', JSON.stringify(rootP, null, 2) + '\n', 'utf8'); bumped += 1; }
console.log('bumped packages:', bumped);
