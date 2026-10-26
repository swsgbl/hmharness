/** 0.23.42 发版准备:版本号 + 44 根跨包钉版(0.23.39→0.23.42) + CHANGELOG + 板级 pins。
 *  事故背景:0.23.40 起两轮发版的 bump 脚本只升 version 忘了升依赖钉——cli@0.23.41
 *  以 kernel@0.23.39 出厂,用户装到混合版本(挂死根修从未真正到达用户)。 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const V = '0.23.42';
const entry = `## [0.23.42] - 2026-10-27

发版管线钉版事故修复（0.23.40/0.23.41 两轮的隐藏雷）：①**事故**——bump 脚本只升各包 \`version\` 忘了升 44 根跨包依赖钉,cli@0.23.40/0.23.41 全部以 kernel@0.23.39 等旧件出厂,用户全局安装得到混合版本树——0.23.40 的挂死根修(kernel ChatOptions.signal)与 0.23.41 的 /evolve 401 根修(loadConfig 派生)从未真正到达任何用户;本机npm缓存掩盖了真相,--prefer-online 重装+registry dependencies 复核才抓到。②**修复**——全部 44 钉同步 0.23.42;版本一致性门禁升级:跨包钉必须等于根版本(硬失败),该类事故从此在 preflight 即被拦下。③**验证**——npm pack 逐包复核钉值 + 全新目录安装 16/16 同版本实测。0.23.41 已不可变,latest 即刻指向本版。

`;

let ch = readFileSync('CHANGELOG.md', 'utf8');
if (!ch.includes(`[${V}]`)) { ch = entry + ch; writeFileSync('CHANGELOG.md', ch, 'utf8'); console.log(`CHANGELOG: ${V} 已插入`); }

let bumped = 0, pinsFixed = 0;
for (const dir of readdirSync('packages')) {
  const p = `packages/${dir}/package.json`;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    let dirty = false;
    if (j.version === '0.23.41') { j.version = V; dirty = true; bumped += 1; }
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
if (rootP.version === '0.23.41') { rootP.version = V; writeFileSync('package.json', JSON.stringify(rootP, null, 2) + '\n', 'utf8'); bumped += 1; }
console.log('bumped versions:', bumped, '| pins synced:', pinsFixed);

const pins = "const FALLBACK_PINS = {\n"
  + `  cli: '${V}', web: '${V}', agent: '${V}', kernel: '${V}',\n`
  + `  sandbox: '${V}', evolution: '${V}', 'domain-ops': '${V}',\n`
  + `  evaluation: '${V}', observability: '${V}', 'domain-harmony': '${V}',\n`
  + '};';
for (const inst of ['scripts/install-kaihongos.cjs', 'packages/cli/board/install-kaihongos.cjs']) {
  const src = readFileSync(inst, 'utf8');
  const next = src.replace(/const FALLBACK_PINS = \{[\s\S]*?\};/, pins);
  if (next !== src) { writeFileSync(inst, next, 'utf8'); console.log(inst, ': pins ->', V); }
}

// release-notes + website
const rnPath = 'packages/cli/release-notes.json';
const rn = JSON.parse(readFileSync(rnPath, 'utf8'));
if (!rn.notes.some((n) => n.v === V)) {
  rn.notes.unshift({ v: V, date: '2026-10-27', note: '发版管线钉版事故修复(0.23.40/0.23.41 混合版本出厂——44 钉同步 0.23.42+一致性门禁硬检查;两轮根修首次真正到达用户)' });
  writeFileSync(rnPath, JSON.stringify(rn, null, 2) + '\n', 'utf8');
  console.log(`release-notes: ${V} 已插入`);
}
for (const f of ['website/llms.txt', 'website/llms-full.txt', 'website/index.html', 'website/faq.html']) {
  let t = readFileSync(f, 'utf8');
  const n = t.split('0.23.41').join(V);
  if (n !== t) { writeFileSync(f, n, 'utf8'); console.log(f, ': 0.23.41 ->', V); }
}
