/** 0.23.51 发版准备:版本号 + 钉 + FALLBACK_PINS + CHANGELOG + release-notes + website。
 *  内容:自进化仪器双修轮 —— 晋升门控三个叠加缺陷根修(PR#41)+ 内核循环去重环过期缓存根修(PR#42)
 *  + 自进化任务重写计划/DEVLOG 六十三。
 *  官网只做【定点】替换: 只改"当前事实"那几处版本号与测试计数; 带日期的历史验证记录
 *  (llms.txt 的 Quickstart 验证矩阵条目)保持原样 —— 全局替换会把它改成当时并不存在的版本。 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
const V = '0.23.51';
const PREV = '0.23.50';
// CI 实测(2026-11-25, PR#42 的 ci run 45530720188): 主套件 tests 1083 / pass 1082 / fail 0 / skipped 1。
// 本机主套件 1080(1079 过 + 1 跳过: 扩展桥守护占用端口 7789) + scripts 44, 零失败。
const TESTS = 1083;
const entry = `## [${V}] - 2026-11-25

自进化仪器双修轮:①**晋升门控三个叠加缺陷**(PR#41)——\`.task\` 正则断言不去 \`/…/\` 定界符(门控集 13/35 题永远判错, train 基线 53.8%→92.5%)、后台环/TUI 的 \`runCase\` 丢弃 \`skillsPrompt\`(晋升门控一直比 A 对 A)、洞察 outcome 把"没超时"记成 \`ok\`(impact 环按错误信号晋升/退役技能);②**内核循环去重环过期缓存**(PR#42)——"相同调用去重环"缓存一切成功调用 20 轮, 且不因写文件/改文件/跑命令而失效; 对会话历史的审计: 命中 151 次, 147 次(97.4%)发生在中间已有改变状态的工具执行之后(\`run_command\` 98、\`read_file\` 25、\`edit_file\` 7、\`harmony_build\` 4)。修法: \`Tool.readOnly\` 声明 + 世界版本失效 —— 只有只读工具、且期间没有非只读调用和运行中注入, 才返回缓存; \`read_file\`/\`list_dir\` 声明只读, 其余工具一律真执行;③DEVLOG 六十三 + 自进化任务重写计划(三个单发任务族天花板 / 构念效度 / agentic 评测管线), 证据见 \`website/evidence/experiments/dedup-staleness-2026-11-25/\`。全套 ${TESTS} 测试(CI 实测: 1082 通过 / 1 跳过; 本机主套件 1080 + scripts 44, 零失败)。

`;
let ch = readFileSync('CHANGELOG.md', 'utf8');
if (!ch.includes(`[${V}]`)) { ch = entry + ch; writeFileSync('CHANGELOG.md', ch, 'utf8'); console.log('CHANGELOG ok'); }
let bumped = 0, pinsFixed = 0;
for (const dir of readdirSync('packages')) {
  const p = `packages/${dir}/package.json`;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    let dirty = false;
    if (j.version === PREV) { j.version = V; dirty = true; bumped += 1; }
    for (const key of ['dependencies', 'devDependencies']) {
      const deps = j[key]; if (!deps) continue;
      for (const [dep, spec] of Object.entries(deps)) {
        if (dep.startsWith('@hmharness/') && spec !== V && spec !== '*') { deps[dep] = V; pinsFixed += 1; dirty = true; }
      }
    }
    if (dirty) writeFileSync(p, JSON.stringify(j, null, 2) + '\n', 'utf8');
  } catch {}
}
const rootP = JSON.parse(readFileSync('package.json', 'utf8'));
if (rootP.version === PREV) { rootP.version = V; writeFileSync('package.json', JSON.stringify(rootP, null, 2) + '\n', 'utf8'); bumped += 1; }
console.log('bumped:', bumped, 'pins:', pinsFixed);
if (bumped !== 17) throw new Error(`expected 17 package versions bumped (root + 16), got ${bumped}`);
const pins = "const FALLBACK_PINS = {\n"
  + `  cli: '${V}', web: '${V}', agent: '${V}', kernel: '${V}',\n`
  + `  sandbox: '${V}', evolution: '${V}', 'domain-ops': '${V}',\n`
  + `  evaluation: '${V}', observability: '${V}', 'domain-harmony': '${V}',\n`
  + `  cognitive: '${V}', environments: '${V}', lsp: '${V}',\n`
  + `  browser: '${V}', extension: '${V}',\n`
  + '};';
for (const inst of ['scripts/install-kaihongos.cjs', 'packages/cli/board/install-kaihongos.cjs']) {
  const s = readFileSync(inst, 'utf8');
  const n = s.replace(/const FALLBACK_PINS = \{[\s\S]*?\};/, pins);
  if (n !== s) { writeFileSync(inst, n, 'utf8'); console.log(inst, 'pins ->', V); }
}
const rn = JSON.parse(readFileSync('packages/cli/release-notes.json', 'utf8'));
if (!rn.notes.some((n) => n.v === V)) {
  rn.notes.unshift({ v: V, date: '2026-11-25', note: `自进化门控三缺陷根修(正则定界符 / runCase 丢 skillsPrompt / outcome 误记 ok)+内核去重环过期缓存根修(97.4% 的命中过期 → 只缓存只读工具且世界未变);${TESTS} 测试` });
  writeFileSync('packages/cli/release-notes.json', JSON.stringify(rn, null, 2) + '\n', 'utf8');
}
const FACTS = [`${TESTS} 个单元测试`, `最新 CI：1082 通过 / 1 跳过`];
const edits = [
  ['website/llms.txt', [
    ['npm 包 @hmharness/cli 0.23.50 · 单仓 16 包', `npm 包 @hmharness/cli ${V} · 单仓 16 包`],
    ['1068 个单元测试 CI 门禁（最新 CI：1067 通过 / 1 跳过）', `${FACTS[0]} CI 门禁（${FACTS[1]}）`],
  ]],
  ['website/llms-full.txt', [
    ['最后更新 2026-11-16，npm 包 @hmharness/cli 0.23.50。', `最后更新 2026-11-25，npm 包 @hmharness/cli ${V}。`],
    ['当前 0.23.50；', `当前 ${V}；`],
    ['1068 个单元测试 CI 门禁（最新 CI：1067 通过 / 1 跳过）', `${FACTS[0]} CI 门禁（${FACTS[1]}）`],
  ]],
  ['website/index.html', [['"softwareVersion":"0.23.50"', `"softwareVersion":"${V}"`]]],
  ['website/faq.html', [
    ['"softwareVersion": "0.23.50"', `"softwareVersion": "${V}"`],
    ['1068 个单元测试门禁（最新 CI：1067 通过 / 1 跳过）', `${FACTS[0]}门禁（${FACTS[1]}）`],
  ]],
];
for (const [f, list] of edits) {
  let t = readFileSync(f, 'utf8');
  for (const [from, to] of list) {
    const n = t.split(from).length - 1;
    if (n !== 1) throw new Error(`${f}: 定点替换未恰好命中一次(${n} 次): ${from}`);
    t = t.replace(from, to);
  }
  writeFileSync(f, t, 'utf8');
  console.log(f, 'updated');
}
