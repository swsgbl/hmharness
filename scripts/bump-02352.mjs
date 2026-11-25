/** 0.23.52 发版准备:版本号 + 钉 + FALLBACK_PINS + CHANGELOG + release-notes + website。
 *  内容:技能正文可达性(PR#43)—— 自进化晋升的技能在真实会话里基本没被读过(1.9%)。
 *  官网只做【定点】替换(同 0.23.51): 只改"当前事实"那几处版本号与测试计数; 历史验证记录保持原样。 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
const V = '0.23.52';
const PREV = '0.23.51';
// CI 实测(2026-11-25, PR#43 的 ci run 45546427691): 主套件 tests 1090 / pass 1089 / fail 0 / skipped 1。
// 本机主套件 1087(1086 过 + 1 跳过) + scripts 44, 零失败。
const TESTS = 1090;
const entry = `## [${V}] - 2026-11-25

技能正文可达性(PR#43):自进化晋升的技能在真实会话里基本没被读过。对会话历史的审计(\`website/evidence/experiments/skill-reach-2026-11-25/\`):注入了技能的 2228 个会话里只有 43 个(1.9%)读到过任何 SKILL.md,77 次读取里 23 次因路径猜错失败。两处修复:①系统提示词的技能清单每行加子目录标记(\`[active]\` / \`[canary]\`),并给出"标记 → 路径"的图例,根目录是本次会话真实的 HMH_HOME(不逐行写完整路径:120 行的技能库每次调用会多约 1800 token);②\`parseDescription\` 规范化换行并支持折叠块标量——此前该库 120 行清单里 65 行的描述是字面的 \`name: <技能名>\`(CRLF frontmatter 没被解析),修后为 0。新增 7 个回归测试;全套 ${TESTS} 测试(CI 实测: 1089 通过 / 1 跳过; 本机主套件 1087 + scripts 44, 零失败)。**未证明**:修复后的技能读取率(待带技能的隔离环境做对照实验)。

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
if (pinsFixed !== 44) throw new Error(`expected 44 pins, got ${pinsFixed}`);
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
  rn.notes.unshift({ v: V, date: '2026-11-25', note: `技能正文可达性:技能清单加目录标记+路径图例,描述提取耐受 CRLF(此前注入技能的会话只有 1.9% 读到过技能正文);${TESTS} 测试` });
  writeFileSync('packages/cli/release-notes.json', JSON.stringify(rn, null, 2) + '\n', 'utf8');
}
const FACTS = [`${TESTS} 个单元测试`, '最新 CI：1089 通过 / 1 跳过'];
const edits = [
  ['website/llms.txt', [
    ['npm 包 @hmharness/cli 0.23.51 · 单仓 16 包', `npm 包 @hmharness/cli ${V} · 单仓 16 包`],
    ['1083 个单元测试 CI 门禁（最新 CI：1082 通过 / 1 跳过）', `${FACTS[0]} CI 门禁（${FACTS[1]}）`],
  ]],
  ['website/llms-full.txt', [
    ['最后更新 2026-11-25，npm 包 @hmharness/cli 0.23.51。', `最后更新 2026-11-25，npm 包 @hmharness/cli ${V}。`],
    ['当前 0.23.51；', `当前 ${V}；`],
    ['1083 个单元测试 CI 门禁（最新 CI：1082 通过 / 1 跳过）', `${FACTS[0]} CI 门禁（${FACTS[1]}）`],
  ]],
  ['website/index.html', [['"softwareVersion":"0.23.51"', `"softwareVersion":"${V}"`]]],
  ['website/faq.html', [
    ['"softwareVersion": "0.23.51"', `"softwareVersion": "${V}"`],
    ['1083 个单元测试门禁（最新 CI：1082 通过 / 1 跳过）', `${FACTS[0]}门禁（${FACTS[1]}）`],
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
