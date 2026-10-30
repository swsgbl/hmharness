/** 0.23.48 发版准备:版本号 + 钉 + FALLBACK_PINS + CHANGELOG + release-notes + website。
 *  内容:forge 集成(PR#39,GitHub/AtomGit 仓库操作工具族)+CI preflight 去重跑(PRCI 假红根修)。 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
const V = '0.23.48';
const PREV = '0.23.47';
const TESTS = 1065;
const entry = `## [${V}] - 2026-10-30

forge 集成——GitHub/AtomGit 仓库操作工具族(PR#39,第十四波 14-A,用户需求"像 VSCode 集成 GitHub 那样在智能体界面直接操作仓库"):①**gh/ag CLI 后端**,shell 调用零新第三方依赖(Windows 上 ag 安装为 ag.cmd,execFile 无法派生故走 exec+平台感知引号加固);②**工具族 15 个**——forge_status/forge_login/repo_list/repo_view/repo_create/pr_list/pr_view/pr_create/pr_merge/issue_list/issue_view/issue_create/release_list/release_view/release_create(host 参数区分 GitHub/AtomGit,两平台参数形态差异全部内化:gh -R+--json 字段表 vs ag 位置参数+布尔 --json);③**7 个写操作接审批卡**(对齐 domain-ops/harmony 写门禁先例);④未装 CLI/未登录返回安装与登录引导(forge_login 走设备码流程并轮询就绪;凭据永远留在 gh/ag 自己的存储,hmharness 不碰令牌);⑤渲染器对 gh 对象字段/ag 字符串字段双形态统一。附:CI verify 作业 preflight 改 --skip-tests(build/typecheck/test 已是独立步骤,同作业重复第二遍全量套件在 windows-latest 撞 30min 超时的假红根修)。全套 ${TESTS} 测试。

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
  rn.notes.unshift({ v: V, date: '2026-10-30', note: `forge 集成:GitHub/AtomGit 仓库操作工具族(gh/ag 后端,登录引导+写操作审批);${TESTS} 测试` });
  writeFileSync('packages/cli/release-notes.json', JSON.stringify(rn, null, 2) + '\n', 'utf8');
}
for (const f of ['website/llms.txt', 'website/llms-full.txt', 'website/index.html', 'website/faq.html']) {
  let t = readFileSync(f, 'utf8');
  const n = t.split(PREV).join(V).replace(/10\d\d 个单元测试/g, `${TESTS} 个单元测试`).replace(/10\d\d unit tests/g, `${TESTS} unit tests`);
  if (n !== t) { writeFileSync(f, n, 'utf8'); console.log(f, 'updated'); }
}
