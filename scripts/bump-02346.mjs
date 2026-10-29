/** 0.23.46 发版准备:版本号 + 钉 + FALLBACK_PINS + CHANGELOG + release-notes + website。
 *  内容:隧道重试风暴根治(PR#37,设备事故复盘)+tui resume picker 闪断根修(PR#34 内)+browser 测试端口环境敏感根修(PR#35)。 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
const V = '0.23.46';
const TESTS = 1042;
const entry = `## [${V}] - 2026-10-29

隧道重试风暴根治(设备"应用用不了"事故复盘,PR#37):①**指数退避+放弃语义**——受限网络下 cloudflared 下载失败→pinggy 兜底→3s 固定间隔无限重试的整夜循环(资源压力致任务子进程间歇静默死亡)根除:冷启动退避 3s→6s→12s→24s→48s…上限 5min;在线断线前 3 次快速后并入阶梯;连续失败 5 次(含存活<60s 短命)彻底放弃并一次性提示,仅手动重试或重启恢复;稳定在线≥60s 退线只计新回合不误杀。②**板级安装器默认 \`web.tunnel=false\`**——孪生安装器共享 \`board-defaults.cjs\`(缺失补 false/显式值绝不覆盖/corrupt 不碰/幂等);板级内网环境不再默认承受互联网隧道风暴。③tui resume picker 闪断根修(轮询条件 alpha→alpha+beta 双行齐,PR#34 内)。④browser startBrowser 测试硬编码 19223=BrowserOS 真实默认口的环境敏感根修→临时空闲口(PR#35,用户机开着 BrowserOS 时翻车)。全套 ${TESTS} 测试。

`;
let ch = readFileSync('CHANGELOG.md', 'utf8');
if (!ch.includes(`[${V}]`)) { ch = entry + ch; writeFileSync('CHANGELOG.md', ch, 'utf8'); console.log('CHANGELOG ok'); }
let bumped = 0, pinsFixed = 0;
for (const dir of readdirSync('packages')) {
  const p = `packages/${dir}/package.json`;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    let dirty = false;
    if (j.version === '0.23.45') { j.version = V; dirty = true; bumped += 1; }
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
if (rootP.version === '0.23.45') { rootP.version = V; writeFileSync('package.json', JSON.stringify(rootP, null, 2) + '\n', 'utf8'); bumped += 1; }
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
  rn.notes.unshift({ v: V, date: '2026-10-29', note: `隧道重试风暴根治(指数退避+放弃)+板级默认 web.tunnel=false;${TESTS} 测试` });
  writeFileSync('packages/cli/release-notes.json', JSON.stringify(rn, null, 2) + '\n', 'utf8');
}
for (const f of ['website/llms.txt', 'website/llms-full.txt', 'website/index.html', 'website/faq.html']) {
  let t = readFileSync(f, 'utf8');
  const n = t.split('0.23.45').join(V).replace(/1037 个单元测试/g, `${TESTS} 个单元测试`).replace(/1037 unit tests/g, `${TESTS} unit tests`);
  if (n !== t) { writeFileSync(f, n, 'utf8'); console.log(f, 'updated'); }
}
