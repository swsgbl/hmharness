/** 0.23.55 发版准备:0.23.54 没有发布到 npm(第一次打标签时,发布流程自带的测试门禁拒绝了它:
 *  新加的 `hmh --version` 回归测试把版本号写死成 0.23.53,发版提交升号之后必红)。
 *  已推送的标签不移动,改以 0.23.55 发布。本脚本把 main 从 0.23.54 升到 0.23.55:
 *  版本号 + 钉 + FALLBACK_PINS + CHANGELOG + release-notes + website + 源码注释里的版本引用。
 *  每个定点替换必须恰好命中一次,否则中止且不写任何文件(先全部校验,再统一写入)。 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
const V = '0.23.55';
const PREV = '0.23.54';
const DATE = '2026-11-26';
// CI(与内容相同的 PR#45, ci run 45738450582):主套件 tests 1182 / pass 1181 / fail 0 / skipped 1。
// 本次只改了一条测试的写法,不增不减;发版提交上再跑一遍全量套件确认。
const CI = { tests: 1182, pass: 1181, fail: 0, skipped: 1, run: '45738450582' };
if (!(CI.tests > 0 && CI.tests === CI.pass + CI.skipped && CI.fail === 0 && CI.run)) {
  throw new Error('先把 CI 实测的 tests/pass/skipped 与 ci run 号填进脚本顶部的 CI 常量');
}

// [文件, [[旧文本, 新文本], ...]] —— 先校验,后写入
const edits = [];
const add = (file, pairs) => edits.push([file, pairs]);

add('CHANGELOG.md', [[
  `## [${PREV}] - ${DATE}`,
  `## [${V}] - ${DATE}\n\n已安装产品复查批:内容与 [${PREV}] 完全相同,另修正一处测试。\`${PREV}\` 没有发布到 npm——第一次打标签时,发布流程自带的测试门禁发现新加的 \`hmh --version\` 回归测试把版本号写死成 0.23.53(发版提交升号之后必红),如实拒绝了发布;已推送的标签不移动,改以 ${V} 发布。该测试现改为从被测包的 package.json 读取版本号。\n\n**测试**:CI 实测 ${CI.tests}(${CI.pass} 通过 / ${CI.skipped} 跳过)。\n\n## [${PREV}] - ${DATE}(未发布到 npm)\n\n> 这一版被发布门禁拒绝(见 [${V}]),npm 上不存在 ${PREV};以下内容原样随 ${V} 发布。`,
]]);

// 官网四处事实:版本号(测试数不变)
add('website/llms.txt', [[`npm 包 @hmharness/cli ${PREV} · 单仓 16 包`, `npm 包 @hmharness/cli ${V} · 单仓 16 包`]]);
add('website/llms-full.txt', [
  [`最后更新 ${DATE}，npm 包 @hmharness/cli ${PREV}。`, `最后更新 ${DATE}，npm 包 @hmharness/cli ${V}。`],
  [`当前 ${PREV}；`, `当前 ${V}；`],
]);
add('website/index.html', [[`"softwareVersion":"${PREV}"`, `"softwareVersion":"${V}"`]]);
add('website/faq.html', [[`"softwareVersion": "${PREV}"`, `"softwareVersion": "${V}"`]]);

// DEVLOG:标题的版本号 + 追加一段如实记录
add('docs/DEVLOG.md', [
  [`查实即修(v${PREV})`, `查实即修(v${V})`],
  [
    '**测试**:CI 实测 1182(1181 通过 / 1 跳过)。新增 56 条回归测试,另有 3 条证据审计脚本的测试。',
    `**发版时被门禁拦下的一次(如实记下)**:第一次打 v${PREV} 标签时,发布流程自带的测试门禁红了——新加的 \`hmh --version\` 回归测试把版本号写死成了 0.23.53:在 PR 上(版本还是 0.23.53)是绿的,到发版提交(已升号)必红。直接原因是测试的写法;根本原因是流程——发版提交上我只跑了类型检查等几项,没有重跑全量套件就打了标签。门禁如实拒绝发布,${PREV} 没有上 npm;已推送的标签不移动,改发 ${V}。测试已改为从被测包的 package.json 读版本号,源码注释里的版本引用一并改准。\n\n**测试**:CI 实测 1182(1181 通过 / 1 跳过)。新增 56 条回归测试,另有 3 条证据审计脚本的测试。`,
  ],
]);

// 源码与测试里的"本版修复"注释:版本不曾发布,引用改到真正发布的版本。[文件, 预期出现次数]
const COMMENT_FILES = [
  ['packages/cli/src/main.ts', 4], ['packages/kernel/src/loop.ts', 2], ['packages/cli/src/evolution-daemon.ts', 2],
  ['packages/cli/src/__tests__/extension-chat-finish.test.ts', 2], ['packages/cli/src/__tests__/daemon-stop-safety.test.ts', 2],
  ['packages/web/src/task-runner.ts', 1], ['packages/web/src/routes/filesystem.ts', 1], ['packages/web/src/page/sse.ts', 1],
  ['packages/web/src/page/shell.ts', 1], ['packages/kernel/src/provider.ts', 1], ['packages/kernel/src/__tests__/provider-finish-reason.test.ts', 1],
  ['packages/kernel/src/__tests__/loop-abort-midcall.test.ts', 1], ['packages/cli/src/web-daemon.ts', 1], ['packages/agent/src/tools.ts', 1],
  ['packages/agent/src/__tests__/write-file.test.ts', 1],
];
const commentEdits = [];
for (const [f, want] of COMMENT_FILES) {
  const t = readFileSync(f, 'utf8');
  const n = t.split(PREV).length - 1;
  if (n !== want) throw new Error(`${f}: 预期 ${want} 处 ${PREV},实际 ${n} 处`);
  commentEdits.push([f, t.split(PREV).join(V)]);
}
// cli-entry.test.ts 里那句"第一次打 0.23.54 标签"是史实,保持不动。

// ---- 先在内存里全部校验并变换 ----
const done = [];
for (const [file, pairs] of edits) {
  let t = readFileSync(file, 'utf8');
  for (const [from, to] of pairs) {
    const n = t.split(from).length - 1;
    if (n !== 1) throw new Error(`${file}: 定点替换必须恰好命中一次(命中 ${n} 次): ${from.slice(0, 70)}`);
    t = t.replace(from, () => to);
  }
  done.push([file, t]);
}
// 版本号 / 钉
const bumped = [];
for (const dir of readdirSync('packages')) {
  const p = `packages/${dir}/package.json`;
  let j;
  try { j = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
  let dirty = false;
  if (j.version === PREV) { j.version = V; dirty = true; }
  for (const key of ['dependencies', 'devDependencies']) {
    const deps = j[key]; if (!deps) continue;
    for (const [dep, spec] of Object.entries(deps)) {
      if (dep.startsWith('@hmharness/') && spec === PREV) { deps[dep] = V; dirty = true; }
    }
  }
  if (dirty) bumped.push([p, JSON.stringify(j, null, 2) + '\n']);
}
const rootP = JSON.parse(readFileSync('package.json', 'utf8'));
if (rootP.version === PREV) bumped.push(['package.json', JSON.stringify({ ...rootP, version: V }, null, 2) + '\n']);
if (bumped.length !== 17) throw new Error(`应升 17 个包的版本(根 + 16),实际 ${bumped.length}`);
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
  if (n === s) throw new Error(`${inst}: FALLBACK_PINS 未变`);
  done.push([inst, n]);
}
// release-notes:从未随任何包发出的 0.23.54 条目换成 0.23.55(同一条说明)
const rnPath = 'packages/cli/release-notes.json';
const rn = JSON.parse(readFileSync(rnPath, 'utf8'));
const at = rn.notes.findIndex((n) => n.v === PREV);
if (at < 0 || rn.notes.some((n) => n.v === V)) throw new Error('release-notes: 找不到 0.23.54 条目或已有 0.23.55');
rn.notes[at] = { ...rn.notes[at], v: V, date: DATE };
done.push([rnPath, JSON.stringify(rn, null, 2) + '\n']);

// ---- 校验全部通过,统一写入 ----
for (const [f, t] of done) writeFileSync(f, t, 'utf8');
for (const [f, t] of commentEdits) writeFileSync(f, t, 'utf8');
for (const [f, t] of bumped) writeFileSync(f, t, 'utf8');
console.log(`release ${V} prepared from ${PREV} (never published): ${bumped.length} versions, ${done.length + commentEdits.length} files, CI ${CI.run} tests ${CI.tests} / pass ${CI.pass} / skipped ${CI.skipped}`);
