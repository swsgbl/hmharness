/** 0.23.43 发版准备:版本号 + 44 钉 + FALLBACK_PINS + CHANGELOG + release-notes + website。
 *  内容:沙箱隔离诚实化+fail-closed(PR#24)、演化守护 30min 超时、FALLBACK_PINS 15 名(PR#25)。 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const V = '0.23.43';
const entry = `## [0.23.43] - 2026-10-27

安全诚实化三连（审计文档包 P0-B + 发版列车候载件齐发）：①**沙箱隔离声明诚实化+fail-closed 执行门禁(Issue #21,PR#24,四轮 CI 攻坚)**——MicroVMSandboxProvider 的 Docker 兜底谎言根除:isAvailable() 仅真实 hypervisor 启动并通过 boot 自测才 true(自测未实现→恒 false),exec/copyIn/copyOut/snapshot/restore 全部 fail closed 抛结构化 IsolationGateError;新增 trust.ts 四档 TrustLevel CapabilityContract(escapeVectors 全部 pin 为 source-level fact);broker critical 决策遇 container-only 机器必炸;红队 R9-R11 反剧场(declared bypass 必须实证真实后果);**CI 三连败定位出的真缺陷:runner 的 Docker 守护进程测试中途预热,probe/detect 两次独立探测各说真话合起来矛盾——修复=单一共享证据快照+派生不再探+假探针注入测试缝**。②**演化守护周期超时 600s→30min**——真实 evolve 周期(40+ 真实调用,20min 实测)超旧上限被恰 600s 击杀;401 时代秒完从未暴露。③**板级安装器 FALLBACK_PINS 补全 15 名(PR#25)**——离线路径 5 包 undefined.tgz 404 根除+发版钉名覆盖断言(cli 声明集⊆pins 名集)。全套 973 测试。

`;

let ch = readFileSync('CHANGELOG.md', 'utf8');
if (!ch.includes(`[${V}]`)) { ch = entry + ch; writeFileSync('CHANGELOG.md', ch, 'utf8'); console.log(`CHANGELOG: ${V} 已插入`); }

let bumped = 0, pinsFixed = 0;
for (const dir of readdirSync('packages')) {
  const p = `packages/${dir}/package.json`;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    let dirty = false;
    if (j.version === '0.23.42') { j.version = V; dirty = true; bumped += 1; }
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
if (rootP.version === '0.23.42') { rootP.version = V; writeFileSync('package.json', JSON.stringify(rootP, null, 2) + '\n', 'utf8'); bumped += 1; }
console.log('bumped versions:', bumped, '| pins synced:', pinsFixed);

// FALLBACK_PINS（15 名版,publish.cjs 新模板）
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
  rn.notes.unshift({ v: V, date: '2026-10-27', note: '沙箱隔离诚实化+fail-closed(Docker 兜底谎言根除/TrustLevel 四档/单一证据源)+演化守护 30min+FALLBACK_PINS 15 名;973 测试' });
  writeFileSync(rnPath, JSON.stringify(rn, null, 2) + '\n', 'utf8');
  console.log(`release-notes: ${V} 已插入`);
}
for (const f of ['website/llms.txt', 'website/llms-full.txt', 'website/index.html', 'website/faq.html']) {
  let t = readFileSync(f, 'utf8');
  const n = t.split('0.23.42').join(V).replace(/954 个单元测试/g, '973 个单元测试').replace(/954 unit tests/g, '973 unit tests');
  if (n !== t) { writeFileSync(f, n, 'utf8'); console.log(f, ': 已更新'); }
}
