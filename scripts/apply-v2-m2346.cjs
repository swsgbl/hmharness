#!/usr/bin/env node
/**
 * V2 M2+M3+M4+M6 integration applier (one-shot, idempotent).
 *
 * The sandbox denied edits to PRE-EXISTING files during the M2-M6 build
 * turn (EPERM on every old path, new files allowed). This script performs
 * the remaining integration the moment locks release:
 *   1. version bumps -> 0.8.0 everywhere (evaluation/sandbox already are)
 *   2. root build/test chains += @hmharness/evaluation + @hmharness/sandbox
 *   3. publish ORDER += evaluation, sandbox (after observability)
 *   4. cli deps += @hmharness/evaluation; new CLI subcommands
 *      (hmh eval list | hmh capability list)
 *   5. CHANGELOG 0.8.0 entry (append-once)
 * Every step checks a marker first; re-running is safe.
 */
const fs = require('fs');
const path = require('path');
const ROOT = __dirname + '/..';

function rw(rel) { return path.join(ROOT, rel); }
function patch(file, find, replace, label) {
  let s = fs.readFileSync(file, 'utf8');
  if (s.includes(replace) || (typeof find === 'string' && !s.includes(find))) {
    console.log('  skip:', label);
    return;
  }
  s = typeof find === 'string' ? s.split(find).join(replace) : s.replace(find, replace);
  fs.writeFileSync(file, s);
  console.log('  applied:', label);
}

const probe = rw('package.json');
try { fs.appendFileSync(probe, ''); } catch {
  console.error('LOCKS STILL HELD - re-run this script when file edits are permitted:');
  console.error('  node scripts/apply-v2-m2346.cjs');
  process.exit(2);
}

console.log('== 1. version bumps 0.7.0 -> 0.8.0');
for (const p of ['kernel', 'observability', 'evolution', 'domain-harmony', 'domain-ops', 'agent', 'web', 'cli']) {
  const f = rw('packages/' + p + '/package.json');
  let s = fs.readFileSync(f, 'utf8');
  if (!s.includes('0.7.0')) { console.log('  skip version:', p); continue; }
  fs.writeFileSync(f, s.replace(/0\.7\.0/g, '0.8.0'));
  console.log('  bumped:', p);
}
{ // root
  const f = probe;
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.version = '0.8.0';
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  console.log('  bumped: root');
}

console.log('== 2. root build/test chains');
patch(probe,
  'npm run build -w @hmharness/kernel && npm run build -w @hmharness/observability &&',
  'npm run build -w @hmharness/kernel && npm run build -w @hmharness/observability && npm run build -w @hmharness/evaluation && npm run build -w @hmharness/sandbox &&',
  'build chain += evaluation, sandbox');
patch(probe,
  'packages/observability/src/__tests__/*.test.ts',
  'packages/observability/src/__tests__/*.test.ts packages/evaluation/src/__tests__/*.test.ts packages/sandbox/src/__tests__/*.test.ts',
  'test glob += evaluation, sandbox');

console.log('== 3. publish ORDER');
for (const s of ['scripts/publish.cjs', 'scripts/publish-preflight.cjs']) {
  patch(rw(s), "'kernel', 'observability', 'evolution'", "'kernel', 'observability', 'evaluation', 'sandbox', 'evolution'", s + ' ORDER');
}

console.log('== 4. cli deps + subcommands');
patch(rw('packages/cli/package.json'),
  '"@hmharness/agent": "0.8.0",',
  '"@hmharness/agent": "0.8.0",\n    "@hmharness/evaluation": "0.8.0",',
  'cli deps += evaluation');

console.log('== 4b. agent exports capability');
patch(rw('packages/agent/src/index.ts'),
  "export { baseTools, readFileTool, writeFileTool, listDirTool, runCommandTool, rememberTool, seeImageTool } from './tools.ts';",
  "export { baseTools, readFileTool, writeFileTool, listDirTool, runCommandTool, rememberTool, seeImageTool } from './tools.ts';\nexport { manifestFor, capabilityReport, authorize, type CapabilityManifest, type CapabilityRisk, type PolicyMode } from './capability.ts';",
  'agent index exports capability');

const main = rw('packages/cli/src/main.ts');
const CLI_BLOCK = `
  if (cmd === 'eval') {
    // V2 M2: the Evaluator surface - hard evidence outranks LLM judgment.
    await initHome();
    const { allEvaluators } = await import('@hmharness/evaluation');
    const { listCases } = await import('@hmharness/evolution');
    const cases = await listCases(homeDir());
    stdout.write('evaluators:\\n' + allEvaluators.map((e) => '  ' + e.id.padEnd(16) + DIM('rank ' + e.evidenceKind) + '  ' + e.description.slice(0, 70)).join('\\n') + '\\n');
    stdout.write('bench cases: ' + cases.length + ' (train ' + cases.filter((c) => !c.holdout).length + ' / holdout ' + cases.filter((c) => c.holdout).length + ')\\n');
    return;
  }
  if (cmd === 'capability') {
    // V2 M4: the capability manifest surface - every tool's declared risk,
    // permissions and approval requirement, inspectable in one place.
    await initHome();
    const { capabilityReport, authorize, buildRegistry } = await import('@hmharness/agent');
    const { reg } = await buildRegistry({ announce: false });
    const mode = rest.includes('--lockdown') ? 'lockdown' : 'standard';
    for (const m of capabilityReport(reg)) {
      const d = authorize(m, mode);
      stdout.write('  ' + (d.allow ? GREEN('allow') : RED('DENY ')) + '  ' + m.risk.padEnd(8) + m.id.padEnd(22) + DIM(m.permissions.join(',')) + '\\n');
    }
    return;
  }
`;
{ // insert before the tui command; idempotent by marker
  let s = fs.readFileSync(main, 'utf8');
  if (s.includes("cmd === 'eval'")) console.log('  skip: cli subcommands');
  else {
    const anchor = "  if (cmd === 'tui') {";
    if (!s.includes(anchor)) throw new Error('main.ts anchor not found');
    s = s.replace(anchor, CLI_BLOCK + anchor);
    fs.writeFileSync(main, s);
    console.log('  applied: cli subcommands (eval, capability)');
  }
}

console.log('== 5. CHANGELOG');
{
  const f = rw('CHANGELOG.md');
  const marker = '## [0.8.0] - 2026-09-12';
  if (fs.readFileSync(f, 'utf8').includes(marker)) console.log('  skip: changelog');
  else {
    const entry = marker + `

**V2 蓝图 P0 第二批(M2+M3+M4+M6)**——Evaluation/Sandbox/Capability/HarmonyBench:

- **新包 @hmharness/evaluation(M2)**:Evaluator 契约+证据阶梯(build=1…llmJudge=7,
  self-report=8);三评测器(text-assertion 五模式/command-exit execFile 硬证据/
  llm-judge **分数硬顶 0.7**——裁判单独通过永远不算满分);evaluateRun 从
  **轨迹记录**(outcome/工具完成率/错误观测)判定并把 judge.completed 回写
  进可审计记录;runBenchCase 让进化门与评测共享同一断言核心。
- **新包 @hmharness/sandbox(M3)**:隔离工作区(git 快照/恢复字节级/diff/
  destroy)+ 三权限层(READ_ONLY 拒执行拒写/WORKSPACE_WRITE/FULL_ACCESS);
  execFile 无 shell 字符串(shellgate 教义);恢复=reset --hard+clean 仅在
  沙箱仓库内(ADR-0001 边界)。
- **Capability 清单层(M4,agent/capability.ts)**:全部注册工具投影为
  manifest(id/risk/permissions/requiresApproval/network/sideEffects)+
  PolicyEngine(lockdown 拒绝一切 host/device/process 触达;revoke 覆盖一切
  模式)。声明层叠加在现有执法层(needsApproval/shellgate/DENY)之上。
- **HarmonyBench 3→26 案例(M6 第一批)**:scripts/bench-cases-v2.cjs 安装
  23 个离线可验证案例(确定性金丝雀/工具知识/领域知识/结构化输出纪律),
  全部 holdout——进化门预算不膨胀,构成晋升后复验语料。
- **SELFFEED 第 8 天**:codelinter 诚实 0 缺陷(模板代码 2 文件);
  **预算门首次生产触发**(5/4 轮超限,当日循环如实跳过留痕)。
- 测试 160+2 → +10(evaluation 5/sandbox 4/capability 2 = 11,去重后全绿)。

`;
    fs.writeFileSync(f, entry + fs.readFileSync(f, 'utf8'));
    console.log('  applied: changelog 0.8.0');
  }
}

console.log('\nINTEGRATION APPLIED. Next:');
console.log('  npm install && npm run build && npm test');
console.log('  node scripts/publish.cjs  (with NODE_AUTH_TOKEN)');
console.log('  npm i -g @hmharness/cli@0.8.0 && restart web daemon && push');
