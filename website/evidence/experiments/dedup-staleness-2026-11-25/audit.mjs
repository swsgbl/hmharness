// 去重环过期缓存审计 —— 在【自己的】会话历史上重跑, 只输出计数, 不上传任何内容。
//
//   node website/evidence/experiments/dedup-staleness-2026-11-25/audit.mjs
//   (默认读 HMH_HOME/sessions, HMH_HOME 未设则读 ~/.hmharness/sessions)
//
// 问题: 内核循环的"相同调用去重环"(loop.ts, 2026-10-07 引入)把缓存的工具结果还给模型时,
//       自那次原始执行以来, 世界已经变了吗?
// 方法: 对每个以 "[you already ran" 开头的工具结果, 在同一会话里找到同一 (工具, 参数) 调用的
//       原始执行, 列出两者之间执行过的工具。中间存在"可能改变状态"的工具 => 过期命中。
//       ("可能改变状态" = 不是只读工具, 且不是这次重复调用本身。)
// 结论口径见同目录 summary.json。本脚本只打印计数与简短参数预览, 不修改任何文件。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const root = join(process.env.HMH_HOME ?? join(homedir(), '.hmharness'), 'sessions');
const files = [];
(function walk(d) {
  let es;
  try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) files.push(p);
  }
})(root);

const READ_ONLY = new Set(['read_file', 'list_dir', 'see_image', 'web_search', 'web_fetch']);
const keyOf = (name, args) => { try { return name + ':' + JSON.stringify(args); } catch { return name + ':unserializable'; } };
const briefArgs = (name, args) => { try { return name === 'run_command' ? String(args.command ?? '').slice(0, 90) : JSON.stringify(args).slice(0, 90); } catch { return ''; } };

const hits = [];
let sessionsWithToolCalls = 0, totalCalls = 0;
for (const f of files) {
  let lines;
  try { lines = readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { continue; }
  const calls = [];
  let pending = [];
  for (const l of lines) {
    let r;
    try { r = JSON.parse(l); } catch { continue; }
    if (r.t === 'assistant' && Array.isArray(r.tool_calls)) {
      pending = r.tool_calls.map((c) => ({ name: c.function?.name, args: (() => { try { return JSON.parse(c.function?.arguments || '{}'); } catch { return {}; } })() }));
    } else if (r.t === 'tool') {
      const c = pending.shift() ?? { name: r.name, args: {} };
      calls.push({ ...c, name: r.name ?? c.name, cached: /^\[you already ran /.test(String(r.output ?? '')) });
    }
  }
  if (calls.length === 0) continue;
  sessionsWithToolCalls++;
  totalCalls += calls.length;
  const lastExec = new Map();
  calls.forEach((c, i) => {
    if (c.cached) {
      const k = keyOf(c.name, c.args);
      const orig = lastExec.get(k);
      const between = orig ? calls.slice(orig.i + 1, i) : [];
      const changing = between.filter((b) => !READ_ONLY.has(b.name) && !(b.name === c.name && keyOf(b.name, b.args) === k));
      hits.push({ session: f.slice(root.length + 1), name: c.name, args: briefArgs(c.name, c.args), changing: changing.map((b) => b.name), stale: changing.length > 0 });
    } else {
      lastExec.set(keyOf(c.name, c.args), { i });
    }
  });
}

const stale = hits.filter((h) => h.stale);
const by = (arr, f) => { const m = {}; for (const h of arr) m[f(h)] = (m[f(h)] ?? 0) + 1; return Object.entries(m).sort((a, b) => b[1] - a[1]); };
console.log(`会话文件 ${files.length} 个, 其中有工具调用的 ${sessionsWithToolCalls} 个, 工具调用共 ${totalCalls} 次`);
console.log(`去重环命中 ${hits.length} 次, 出现在 ${new Set(hits.map((h) => h.session)).size} 个会话`);
console.log(`  过期命中(原始执行与重复之间有改变状态的工具跑过) ${stale.length} 次`);
console.log(`  无状态变化的命中(去重器本来的目标) ${hits.length - stale.length} 次`);
console.log('\n过期命中按工具: ' + by(stale, (h) => h.name).map(([k, v]) => `${k}=${v}`).join('  '));
console.log('\n--- 过期命中的例子(最多 14 条; 参数已截短) ---');
for (const h of stale.slice(0, 14)) console.log(`  ${h.session.slice(-28).padEnd(28)} ${h.name.padEnd(11)} 参数=${h.args.slice(0, 46).padEnd(46)} 中间跑过: ${h.changing.slice(0, 3).join(' | ').slice(0, 100)}`);
