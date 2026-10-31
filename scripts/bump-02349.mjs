/** 0.23.49 发版准备:版本号 + 钉 + FALLBACK_PINS + CHANGELOG + release-notes + website + EXTENSION_VERSION。
 *  内容:浏览器扩展桥终局轮——侧栏极简交互界面(ChatGPT 扩展同款)、逐浏览器真 chat E2E 八台全通、
 *  桥三层保活(守护/看门狗/计划任务)、浏览器版本矩阵文档(通用版/Firefox 特例/BrowserOS ACP)。 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
const V = '0.23.49';
const PREV = '0.23.48';
const TESTS = 1065; // npm test 实测(2026-10-31:1066 总数,1 跳过=守护占端口正确跳过)
const entry = `## [${V}] - 2026-10-31

浏览器扩展桥终局轮(用户验收标准:"右侧浏览器交互,AI 交互框,实测发消息,能读懂整个网页",每台浏览器都要过):①**侧栏极简交互界面**(ChatGPT 扩展同款:居中欢迎语+三张建议卡片+单输入框,状态/端口/重连收进 ⚙ 抽屉,SVG 齿轮高对比);②**逐浏览器真 chat E2E 八台全通**(每台真启动→连接→模拟面板发消息→验证 AI 读到网页标题:Edge/Brave/Helium/Tabbit 走快捷方式通道,Chrome 156/Opera 138 品牌 137+ 移除 --load-extension → **pi computer-use GUI 手动装载**自动化三步对话框,夸克 7.4 flag+GUI,Firefox 156 **about:debugging 临时载入**隔离验证连接流 browser=firefox);③**浏览器版本矩阵文档**(扩展 README:通用扩展版=全部 Chromium 系同一份代码/Firefox 特例=XPI 临时载入持久化待 AMO/BrowserOS=ACP 通道不装扩展);④桥三层保活收尾(守护/进程看门狗/Windows 计划任务,强杀 80s 自愈实测);⑤双 bug 修复:面板计时器泄漏(回答后气泡复活)+活动环连接噪音(SW 重连行涌入面板——活动环改大脑步骤专用,取证行移守护日志)。全套 ${TESTS} 测试(1 跳过=守护占端口正确跳过)。

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
  rn.notes.unshift({ v: V, date: '2026-10-31', note: `浏览器扩展桥终局:侧栏极简界面(ChatGPT 扩展同款)+逐浏览器真 chat E2E 八台全通(Chrome/Opera GUI 手动装载,Firefox 临时载入)+浏览器版本矩阵文档(通用版/Firefox 特例/BrowserOS ACP);桥三层保活;${TESTS} 测试` });
  writeFileSync('packages/cli/release-notes.json', JSON.stringify(rn, null, 2) + '\n', 'utf8');
}
for (const f of ['website/llms.txt', 'website/llms-full.txt', 'website/index.html', 'website/faq.html']) {
  let t = readFileSync(f, 'utf8');
  const n = t.split(PREV).join(V).replace(/10\d\d 个单元测试/g, `${TESTS} 个单元测试`).replace(/10\d\d unit tests/g, `${TESTS} unit tests`);
  if (n !== t) { writeFileSync(f, n, 'utf8'); console.log(f, 'updated'); }
}
// EXTENSION_VERSION: payload changed meaningfully (minimal UI + fixes)
{
  const p = 'packages/extension/src/adapters.ts';
  const t = readFileSync(p, 'utf8');
  const n = t.replace(/EXTENSION_VERSION = '0\.23\.31';/, `EXTENSION_VERSION = '0.23.32';`);
  if (n !== t) { writeFileSync(p, n, 'utf8'); console.log('EXTENSION_VERSION -> 0.23.32'); }
}
