/** 0.23.44 发版准备:版本号 + 44 钉 + FALLBACK_PINS + CHANGELOG + release-notes + website。
 *  内容:外部复现包 P2-1(PR#29)、web page.ts 3833 行拆 12 域(PR#30)、
 *  TUI 终端 markdown 渲染器(PR#31)、系统提示词最终答复结构规范(PR#32)。 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const V = '0.23.44';
const TESTS = 1036; // npm test 实测(2026-10-29 全套:1036 总数;4 个本地失败为 Windows libuv routes-* 环境族,CI Linux 全绿)
const entry = `## [${V}] - 2026-10-29

结构化结论输出双修 + 可复现性收官（用户三家 CLI 对比实测反馈驱动）：①**TUI 终端 markdown 渲染器(PR#31)**——用户对比 Codex/Claude Code/hmh 三家输出截图:hmh 的 \`#\` 井号、\`**\` 星号、\`|---|\` 管道分隔行原样透传、表格对齐散架;根因是 \`mdColor()\` 只是 6 行行首着色器。新增零依赖 \`packages/cli/src/markdown.ts\`(424 行):单遍 O(n) 块扫描(围栏/表格/标题/hr/引用/列表/段落)+行内状态机(粗体/反色代码/下划线链接/转义);表格 box 边框+CJK 双宽等宽对齐+冒号对齐+超宽列截断;流式接入 say 流(未闭合块随 chunk 重排,已闭合块纯函数不变);resume/transcript 同渲染器;28 例新测试。②**系统提示词最终答复结构规范(PR#32)**——移植 openai/codex \`gpt_5_2_prompt.md\` 尾部 "Final answer structure and style guidelines"(此前只移植了执行纪律类,漏掉输出干净度核心层):冗长度阶梯/要点 4-6 条不嵌套/反引号约定/path:line 文件引用/findings-first/简单事零格式/不贴大段代码;hmh 适配标准 markdown 双渲染+中文条款。③**外部复现包 P2-1(PR#29)**——打包器配方驱动产自包含复现包(skill-gen 47 文件/three-arm-v2 87 文件),仓库外全新目录纯 node reproduce 实测 IDENTICAL;已随 gh-pages 公开。④**web page.ts 3833 行拆分(PR#30)**——13 刀切出 12 个域模块,page.ts 收敛为 55 行装配层,纯结构重构零行为变更。全套 ${TESTS} 测试。

`;

let ch = readFileSync('CHANGELOG.md', 'utf8');
if (!ch.includes(`[${V}]`)) { ch = entry + ch; writeFileSync('CHANGELOG.md', ch, 'utf8'); console.log(`CHANGELOG: ${V} 已插入`); }

let bumped = 0, pinsFixed = 0;
for (const dir of readdirSync('packages')) {
  const p = `packages/${dir}/package.json`;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    let dirty = false;
    if (j.version === '0.23.43') { j.version = V; dirty = true; bumped += 1; }
    for (const key of ['dependencies', 'devDependencies']) {
      const deps = j[key];
      if (!deps) continue;
      for (const [dep, spec] of Object.entries(deps)) {
        if (dep.startsWith('@hmharness/') && spec !== V && spec !== '*') { deps[dep] = V; pinsFixed += 1; dirty = true; }
      }
    }
    if (dirty) writeFileSync(p, JSON.stringify(j, null, 2) + '\n', 'utf8');
  } catch { /* 非包子目录 */ }
}
const rootP = JSON.parse(readFileSync('package.json', 'utf8'));
if (rootP.version === '0.23.43') { rootP.version = V; writeFileSync('package.json', JSON.stringify(rootP, null, 2) + '\n', 'utf8'); bumped += 1; }
console.log('bumped versions:', bumped, '| pins synced:', pinsFixed);

// FALLBACK_PINS(15 名版)
const pins = "const FALLBACK_PINS = {\n"
  + `  cli: '${V}', web: '${V}', agent: '${V}', kernel: '${V}',\n`
  + `  sandbox: '${V}', evolution: '${V}', 'domain-ops': '${V}',\n`
  + `  evaluation: '${V}', observability: '${V}', 'domain-harmony': '${V}',\n`
  + `  cognitive: '${V}', environments: '${V}', lsp: '${V}',\n`
  + `  browser: '${V}', extension: '${V}',\n`
  + '};';
for (const inst of ['scripts/install-kaihongos.cjs', 'packages/cli/board/install-kaihongos.cjs']) {
  const src = readFileSync(inst, 'utf8');
  const next = src.replace(/const FALLBACK_PINS = \{[\s\S]*?\};/, pins);
  if (next !== src) { writeFileSync(inst, next, 'utf8'); console.log(inst, ': pins ->', V); }
}

const rnPath = 'packages/cli/release-notes.json';
const rn = JSON.parse(readFileSync(rnPath, 'utf8'));
if (!rn.notes.some((n) => n.v === V)) {
  rn.notes.unshift({ v: V, date: '2026-10-29', note: `结构化结论输出双修(TUI markdown 渲染器+Codex 式答复结构规范)+外部复现包 P2-1+web page.ts 拆分;${TESTS} 测试` });
  writeFileSync(rnPath, JSON.stringify(rn, null, 2) + '\n', 'utf8');
  console.log(`release-notes: ${V} 已插入`);
}
for (const f of ['website/llms.txt', 'website/llms-full.txt', 'website/index.html', 'website/faq.html']) {
  let t = readFileSync(f, 'utf8');
  const n = t.split('0.23.43').join(V).replace(/993 个单元测试/g, `${TESTS} 个单元测试`).replace(/993 unit tests/g, `${TESTS} unit tests`);
  if (n !== t) { writeFileSync(f, n, 'utf8'); console.log(f, ': 已更新'); }
}
