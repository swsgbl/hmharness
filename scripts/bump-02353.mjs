/** 0.23.53 发版准备:版本号 + 钉 + FALLBACK_PINS + CHANGELOG + release-notes + website + AGENTS。
 *  内容:现代 Web 改造(基于 modern-web-guidance 的全项目升级,PR#44)——网页端安全与无障碍、
 *  官网去 CDN、扩展侧栏、非界面代码按指南现代化。
 *  官网只做"定点替换"(含首页的测试数——历次发版脚本漏了它,首页停在 1068 而 FAQ 已是 1090;
 *  check-website.cjs 规则 7 现在要求四处一致)。 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
const V = '0.23.53';
const PREV = '0.23.52';
const DATE = '2026-11-26';
const PR = 'PR#44';
// CI 实测(2026-11-26, PR#44 的 ci run 45696200021): 主套件 tests 1126 / pass 1125 / fail 0 / skipped 1。
// 本机主套件 1123(1122 通过 + 1 跳过) + scripts 44, 零失败(与本机相差 3, 和此前各版一样是平台差异)。
const CI = { tests: 1126, pass: 1125, fail: 0, skipped: 1, run: '45696200021' };
if (!(CI.tests > 0 && CI.tests === CI.pass + CI.skipped && CI.fail === 0 && CI.run)) {
  throw new Error('先把 CI 实测的 tests/pass/skipped 与 ci run 号填进脚本顶部的 CI 常量');
}
const TESTS = CI.tests;
const entry = `## [${V}] - ${DATE}

现代 Web 改造(基于 modern-web-guidance 技能的全项目升级,${PR}):三处界面全面加固,非界面代码按指南现代化。

**网页端安全**:① nonce 随机数 CSP(\`script-src 'nonce-…' 'strict-dynamic'\`)+ 基础安全头(X-Content-Type-Options / Referrer-Policy / Cross-Origin-Resource-Policy / Permissions-Policy / frame-ancestors 'none')+ \`POST /api/csp-report\` 上报接口;② GSAP CDN 脚本移除——入场动效改用 Web Animations API(仅动 opacity 与独立 transform 属性,fill 仅 backwards,实时跟随"减少动效")。

**网页端无障碍**:地标(aside/main)、导航与输入的可访问名称随语言同步、会动作的元素全部原生 button、三个弹层的背景置为 inert(键盘出不去)、右栏标准 tablist(方向键/Home/End)、统一的 focus-visible 焦点环、100dvh、减少动效、强制色、根元素 color-scheme。顺带修掉两个原有缺陷:命令面板的回车缺输入法组合保护(选词即误执行);Shift+Enter 换行被 preventDefault 吞掉(占位文字承诺了换行,0.23.52 实测"第一行第二行"连在一起)。键盘走查:右栏关闭时旧版有 8 个看不见的焦点停靠点,新版 0 个。

**官网(6 页 + 生成页)**:首页去掉 GSAP CDN 改原生动画,并加动效开关(记住偏好);每页都有 <main>、跳转链接与 color-scheme;导航锚点不再被导航栏遮挡;强制色模式下标题与统计数字可见(此前是透明的);表头 scope、可滚动区键盘可达、字号用 rem、打印样式;320–1280 四种宽度零横向溢出(此前首页在 320/768、FAQ 在 320 溢出)。\`scripts/check-website.cjs\` 新增三组守门规则(无第三方资源/内联事件/横向裁切,页面结构,测试数四处一致),并修正首页过期的测试数。

**浏览器扩展侧栏**:标题与主地标、端口输入有标签、状态点用形状 + 可访问名称区分状态、对话区 role=log 且只追加新消息(此前每条消息重建全部,读屏会重读整段)、输入法回车兜底、统一焦点环。

**非界面代码**:\`toSorted\`/\`toReversed\`/\`findLast\` 13 处、\`Error(msg, { cause })\` 5 处、\`AbortSignal.timeout\` 3 处(kernel 新增 \`deadlineSignal\`)、\`structuredClone\` 1 处;修复 Git Bash 下恢复检查点必败(tar 把盘符当远程主机)。

**测试**:CI 实测 ${TESTS}(${CI.pass} 通过 / ${CI.skipped} 跳过)。

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
  rn.notes.unshift({ v: V, date: DATE, note: `现代 Web 改造:网页端随机数 CSP + 安全头 + 无障碍(去 GSAP CDN,修 Shift+Enter 换行与命令面板输入法回车);官网去 CDN + 动效开关 + 地标/跳转链接,320–1280 零横向溢出;扩展侧栏无障碍;${TESTS} 测试` });
  writeFileSync('packages/cli/release-notes.json', JSON.stringify(rn, null, 2) + '\n', 'utf8');
}
// 上一版的数字(0.23.52 的 CI 实测):每条"定点替换"都必须恰好命中一次
const FACTS = [`${TESTS} 个单元测试`, `最新 CI：${CI.pass} 通过 / ${CI.skipped} 跳过`];
const edits = [
  ['website/llms.txt', [
    [`npm 包 @hmharness/cli ${PREV} · 单仓 16 包`, `npm 包 @hmharness/cli ${V} · 单仓 16 包`],
    ['1090 个单元测试 CI 门禁（最新 CI：1089 通过 / 1 跳过）', `${FACTS[0]} CI 门禁（${FACTS[1]}）`],
  ]],
  ['website/llms-full.txt', [
    ['最后更新 2026-11-25，npm 包 @hmharness/cli 0.23.52。', `最后更新 ${DATE}，npm 包 @hmharness/cli ${V}。`],
    [`当前 ${PREV}；`, `当前 ${V}；`],
    ['1090 个单元测试 CI 门禁（最新 CI：1089 通过 / 1 跳过）', `${FACTS[0]} CI 门禁（${FACTS[1]}）`],
  ]],
  ['website/index.html', [
    [`"softwareVersion":"${PREV}"`, `"softwareVersion":"${V}"`],
    ['<b>1090</b><span data-i18n="s3">单元测试(1089 通过/1 跳过)</span>', `<b>${TESTS}</b><span data-i18n="s3">单元测试(${CI.pass} 通过/${CI.skipped} 跳过)</span>`],
    ["s3: '单元测试(1089 通过/1 跳过)'", `s3: '单元测试(${CI.pass} 通过/${CI.skipped} 跳过)'`],
  ]],
  ['website/faq.html', [
    [`"softwareVersion": "${PREV}"`, `"softwareVersion": "${V}"`],
    ['1090 个单元测试门禁（最新 CI：1089 通过 / 1 跳过）', `${FACTS[0]}门禁（${FACTS[1]}）`],
  ]],
  // AGENTS.md 引用的测试数("at time of writing")随发版更新
  ['AGENTS.md', [
    ['full unit suite (CI gate; 909 tests at time of writing)', `full unit suite (CI gate; ${TESTS} tests at time of writing)`],
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
console.log(`release ${V} prepared with CI ${CI.run}: tests ${CI.tests} / pass ${CI.pass} / skipped ${CI.skipped}`);
