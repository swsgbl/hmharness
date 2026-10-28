/** 0.23.45 发版准备:版本号 + 钉 + FALLBACK_PINS + CHANGELOG + release-notes + website。
 *  内容:server close() 句柄全排干与 CI 假绿根修(PR#33)、clean-room 发版验真自动化(P0-2 收官,PR#34)。 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
const V = '0.23.45';
const TESTS = 1037;
const entry = `## [0.23.45] - 2026-10-29

测试诚实化双收官（审计文档 03 P0-2 验收门关闭 + 本机 DX 债清偿）：①**server close() 句柄全排干与 CI 假绿根修(PR#33)**——旧 close() 路径有无条件 process.exit(0),库上下文里直接击杀测试宿主进程:Windows 上与活着的 libuv async 句柄竞态触发 \`UV_HANDLE_CLOSING\` 断言(routes-* 四测试本机连崩三轮),Linux CI 同样被提前击杀——**此前的 CI 全绿是假绿**,掩盖自 2026-10-18 拆分起的 5 个潜伏缺陷(port-0 回显/ pair-rotate PRE-rotate 状态/两个守卫断言与产品合同不符/extension-status 环境依赖);修复=统一句柄登记表+closeOnce() LIFO 排干+closed 标志门住 SSE 写入侧+库层绝不 process.exit+close 幂等;新增 server-close 回归(挂起 SSE 连接终止且进程存活);修复后**本机全套首次全绿**(1037 零 fail)。②**clean-room 发版验真自动化(P0-2 收官,PR#34)**——\`scripts/cleanroom-verify.cjs\`:官方源 tarball 下载(sha256+npm integrity 双指纹)→全新目录+全新缓存隔离安装→15 包钉版核验(第 16 包 codexhost-bridge 依赖图外走 registry 确认)→关键路径实跑(check//api/state/任务受理+interrupt/rollout/resume/bench/evolve,无 key 边界如实记录)→工件归档 \`website/evidence/cleanroom/\`;工件写入时单点脱敏(OS 用户名→<user>,SANITIZATION.md 记 sha256 前像);单测 11 例接入 npm test 链;v0.23.44 三次运行+指挥者独立真跑均 11/11 PASS。③tui resume picker 闪断根修(轮询条件 alpha→alpha+beta 双行齐)。全套 1037 测试(本地全绿)。

`;
let ch = readFileSync('CHANGELOG.md', 'utf8');
if (!ch.includes(`[${V}]`)) { ch = entry + ch; writeFileSync('CHANGELOG.md', ch, 'utf8'); console.log('CHANGELOG ok'); }
let bumped = 0, pinsFixed = 0;
for (const dir of readdirSync('packages')) {
  const p = `packages/${dir}/package.json`;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    let dirty = false;
    if (j.version === '0.23.44') { j.version = V; dirty = true; bumped += 1; }
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
if (rootP.version === '0.23.44') { rootP.version = V; writeFileSync('package.json', JSON.stringify(rootP, null, 2) + '\n', 'utf8'); bumped += 1; }
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
  rn.notes.unshift({ v: V, date: '2026-10-29', note: `测试诚实化双收官:server close 句柄排干(CI 假绿根修+5 潜伏缺陷+本机首次全绿)+clean-room 发版验真自动化(P0-2);${TESTS} 测试` });
  writeFileSync('packages/cli/release-notes.json', JSON.stringify(rn, null, 2) + '\n', 'utf8');
}
for (const f of ['website/llms.txt', 'website/llms-full.txt', 'website/index.html', 'website/faq.html']) {
  let t = readFileSync(f, 'utf8');
  const n = t.split('0.23.44').join(V).replace(/1036 个单元测试/g, `${TESTS} 个单元测试`).replace(/1036 unit tests/g, `${TESTS} unit tests`);
  if (n !== t) { writeFileSync(f, n, 'utf8'); console.log(f, 'updated'); }
}
