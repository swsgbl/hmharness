/**
 * Three-arm experiment analysis (phase 4). Reads ONLY what phases 0-3 wrote;
 * emits analysis.json + report.md. Verdict language is enumerated from the
 * pre-registered gate — no post-hoc wording, no number editing.
 * Run: npx tsx scripts/three-arm-analyze.mts
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPERIMENT_ID, compareArms, evaluateGate, nullFlux,
  type RunRecord,
} from '../packages/evolution/src/three-arm.ts';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXP = join(REPO_ROOT, 'website', 'evidence', 'experiments', 'three-arm-2026-10-27');
const PHASES = join(EXP, 'phases');
const SHA = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

const manifest = JSON.parse(readFileSync(join(EXP, 'manifest.json'), 'utf8')) as {
  datasetHashUnused?: string; frozen: { taskSet: { datasetHash: string; counts: { train: number; protect: number } } };
};
const nullRecords = loadJsonl('0-null.jsonl');
const mainRecords = loadJsonl('3-main.jsonl');
const predictions = loadPredictions();
const candidate = JSON.parse(readFileSync(join(PHASES, '1-candidate.json'), 'utf8')) as {
  candidate: { name: string; skill_md: string } | null; candidateSha?: string; promptSha: string; gateOutcome?: string; gateRejectedReason?: string;
};
const gate = existsSync(join(PHASES, '2-gate.json'))
  ? JSON.parse(readFileSync(join(PHASES, '2-gate.json'), 'utf8')) as { outcome?: { action: string; reason: string } }
  : null;

function loadJsonl(name: string): RunRecord[] {
  const f = join(PHASES, name);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as RunRecord);
}
function loadPredictions(): Map<string, number | null> {
  const f = join(PHASES, 'predictions.jsonl');
  if (!existsSync(f)) return new Map();
  return new Map(readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
    const j = JSON.parse(l) as { seed: number; taskId: string; p: number | null };
    return [`${j.seed}:${j.taskId}`, j.p];
  }));
}

/* crash runs count as task failure in the primary analysis (pre-registered);
   C-not-deployable placeholders are excluded from C (reported separately) */
const asPrimary = (rs: RunRecord[]): RunRecord[] =>
  rs.map((r) => (r.decision === 'crash' && !r.reason.startsWith('C-arm not deployable')
    ? { ...r, outcome: { ...r.outcome, success: false } } : r))
    .filter((r) => !r.reason.startsWith('C-arm not deployable'));

const cDeployable = !mainRecords.some((r) => r.reason.startsWith('C-arm not deployable')) && candidate.gateOutcome === 'promoted';
const cPlaceholderCount = mainRecords.filter((r) => r.reason.startsWith('C-arm not deployable')).length;

const primary = asPrimary(mainRecords);

/* ---- rates + secondary metrics per arm/split ---- */
interface ArmStats { runs: number; pass: number; rate: number; tokens: number | null; wallMsAvg: number; toolCalls: number; recoveries: number; crashes: number; falseCompletion: number; brier: number | null; crashRate: number }
function armStats(rs: RunRecord[], arm: string, split?: 'train' | 'protect'): ArmStats {
  const sel = rs.filter((r) => r.arm === arm && (split === undefined || r.holdoutClass === split));
  const measured = sel.filter((r) => r.metrics.cost.totalTokens !== null || r.decision !== 'crash');
  const tok = sel.reduce((s, r) => s + (r.metrics.cost.totalTokens ?? 0), 0);
  const briers = sel.filter((r) => r.metrics.brier !== null);
  return {
    runs: sel.length,
    pass: sel.filter((r) => r.outcome.success === true).length,
    rate: sel.length ? Number((sel.filter((r) => r.outcome.success === true).length / sel.length).toFixed(4)) : 0,
    tokens: tok > 0 ? tok : null,
    wallMsAvg: measured.length ? Math.round(sel.reduce((s, r) => s + r.metrics.wallMs, 0) / sel.length) : 0,
    toolCalls: sel.reduce((s, r) => s + r.metrics.toolCalls, 0),
    recoveries: sel.reduce((s, r) => s + r.metrics.recoveries, 0),
    crashes: sel.filter((r) => r.metrics.crashes === 1).length,
    falseCompletion: sel.filter((r) => r.metrics.falseCompletion === 1).length,
    brier: briers.length ? Number((briers.reduce((s, r) => s + (r.metrics.brier ?? 0), 0) / briers.length).toFixed(4)) : null,
    crashRate: sel.length ? Number((sel.filter((r) => r.metrics.crashes === 1).length / sel.length).toFixed(4)) : 0,
  };
}

const stats: Record<string, ArmStats> = {};
for (const arm of ['A', 'B', 'C'] as const) {
  for (const split of ['train', 'protect', undefined] as Array<'train' | 'protect' | undefined>) {
    stats[`${arm}:${split ?? 'all'}`] = armStats(primary, arm, split);
  }
}

/* ---- the four comparisons (main + 3 exploratory) ---- */
const mainCmp = compareArms(primary, 'C', 'A', 'protect');
const exploratory = [
  compareArms(primary, 'B', 'A', 'protect'),
  compareArms(primary, 'C', 'A', 'train'),
  compareArms(primary, 'B', 'A', 'train'),
];

/* ---- null flux (phase 0) ---- */
const flux = { train: nullFlux(asPrimary(nullRecords), 'train'), protect: nullFlux(asPrimary(nullRecords), 'protect') };

/* ---- cost gate: phase-3 C vs A total tokens (same execution window) ---- */
const tokensOf = (arm: string) => primary.filter((r) => r.arm === arm).reduce((s, r) => s + (r.metrics.cost.totalTokens ?? 0), 0);
const tokA = tokensOf('A');
const tokC = tokensOf('C');
const costGrowth = tokA > 0 && tokC > 0 ? Number(((tokC - tokA) / tokA).toFixed(4)) : Number.NaN;

/* ---- the pre-registered gate ---- */
const gateResult = cDeployable && mainCmp.bootstrap.nTasks > 0
  ? evaluateGate(mainCmp, mainCmp.diff, Number.isNaN(costGrowth) ? 1 : costGrowth)
  : { verdict: 'NEEDS-DATA' as const, gates: [], reason: cDeployable ? 'no C-arm records' : 'C arm not deployable: the evolution gate rejected every candidate version (this IS the honest outcome of the persistent-evolution path)' };

/* ---- per-task disagreement tables (failure cases) ---- */
function disagreements(x: 'B' | 'C', split: 'train' | 'protect'): { xWon: string[]; aWon: string[] } {
  const xs = new Map(primary.filter((r) => r.arm === x && r.holdoutClass === split).map((r) => [`${r.seed}:${r.taskId}`, r.outcome.success === true]));
  const as = new Map(primary.filter((r) => r.arm === 'A' && r.holdoutClass === split).map((r) => [`${r.seed}:${r.taskId}`, r.outcome.success === true]));
  const xWon: string[] = []; const aWon: string[] = [];
  for (const [k, v] of xs) {
    const a = as.get(k);
    if (a === undefined) continue;
    if (v && !a) xWon.push(k);
    else if (!v && a) aWon.push(k);
  }
  return { xWon: xWon.sort(), aWon: aWon.sort() };
}

const analysis = {
  experimentId: EXPERIMENT_ID,
  generatedAt: new Date().toISOString(),
  datasetHash: manifest.frozen.taskSet.datasetHash,
  cDeployable,
  cPlaceholderCount,
  candidate: { name: candidate.candidate?.name ?? null, sha: candidate.candidateSha ?? null, gateOutcome: candidate.gateOutcome ?? null, gateRejectedReason: candidate.gateRejectedReason ?? null },
  stats,
  mainEndpoint: mainCmp,
  exploratory,
  nullFlux: flux,
  cost: { tokensA: tokA, tokensC: tokC, costGrowth: Number.isNaN(costGrowth) ? null : costGrowth },
  gate: gateResult,
  disagreements: {
    'C-vs-A-protect': disagreements('C', 'protect'),
    'B-vs-A-protect': disagreements('B', 'protect'),
    'C-vs-A-train': disagreements('C', 'train'),
  },
  predictions: { count: predictions.size },
};
writeFileSync(join(EXP, 'analysis.json'), JSON.stringify(analysis, null, 2) + '\n', 'utf8');

/* ================= report.md (delivery template) ================= */
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const fmtCmp = (c: typeof mainCmp, exploratoryNote: string) => {
  const m = c.mcnemarPerSeed.map((s) => `seed${s.seed}: ${s.xOnly}/${s.yOnly} discordant, p=${s.p}`).join('; ');
  return [
    `#### ${c.comparison} @ ${c.split} ${exploratoryNote}`,
    `- 成功率: ${c.armX} ${pct(c.rateX)} vs ${c.armY} ${pct(c.rateY)}(差 ${pct(c.diff)})`,
    `- 任务级配对差 bootstrap 95% CI: [${c.bootstrap.ciLo}, ${c.bootstrap.ciHi}](宽度 ${c.bootstrap.width}, n=${c.bootstrap.nTasks} 任务)`,
    `- 逐 seed 精确 McNemar: ${m}`,
    `- 显著(预注册标准): ${c.significant ? '是' : '否'}${c.needsData.length ? `;低支持度: ${c.needsData.join('; ')}` : ''}`,
  ].join('\n');
};

const protectFileList = readdirSync(join(EXP, 'protect')).sort();
const verdictText: Record<string, string> = {
  PROMOTE: `**PROMOTE**——候选通过全部预注册晋升门(显著性 + 保护集回退 ≤3pp + 成本增幅 ≤10%)。C 臂的持久化改动在冻结 base model 下提高了保护集任务成功率且未破坏保护任务。`,
  REJECT: `**REJECT**——候选未通过预注册晋升门:${gateResult.reason}。按门控纪律,该改动不得持久化部署。`,
  'NEED-DATA': `**NEED-DATA**——${gateResult.reason}`,
};

const report = `# 三臂主实验报告:${EXPERIMENT_ID}

> 研究问题:一项可持久化的 harness/skill 改动在冻结 base model 下是否提高任务成功率且不破坏保护任务。
> 本报告由 scripts/three-arm-analyze.mts 从 phases/ 落盘数据生成;判定语言按预注册枚举,无手工修饰。

## 一、事实 / 假设 / 缺证据

| 类别 | 内容 |
|---|---|
| **事实** | ① 任务集来自本机既有 bench 语料(${manifest.frozen.taskSet.counts.train} train + ${manifest.frozen.taskSet.counts.protect} protect,datasetHash 见第七节);② 三臂除注入物外一切冻结(provider=glm-5.3、无采样参数、同 system prompt 模板、maxTurns=6、只读工具、每任务新会话);③ 判定为程序化断言(exact/regex/none/any),不接受模型自述;④ C 臂候选经仓库真实 evolution 门控(runEvolution:双采样、无回归、质量地板 0.6、成本帽、gate-val 复验)后才部署。 |
| **假设** | ① 服务端模型行为在实验窗口内稳定(同日执行);② glm-5.3 在相同 wire 请求(不发送采样参数)下行为一致;③ B 臂教训仅来自 train 同族失败(代码保证),无保护集泄漏。 |
| **缺证据** | ① 美元成本:glm coding plan 为包月,单位调用成本不可得(cost 记 token 数,usd=null);② 更大任务量下的效应(本规模为 pilot;支持度门见 NEEDS-DATA 清单);③ 除本机 bench 族外的泛化(hmb 族 holdout 以知识问答为主)。 |

## 二、实验设计(预注册,先于任何数据冻结于 manifest.json)

- **三臂**:A=Baseline(冻结技能库快照原样注入);B=Task-adaptive(同快照 + 每任务临时适应块,内容为 train 同族 null 失败教训,任务后丢弃);C=Persistent-evolved(同快照 + 经门控晋升的候选 skill,注入构造与门控期逐字节一致)。
- **固定**:模型 glm-5.3(zhipu coding plan,不发送任何采样参数)、system prompt 模板(buildSystemPrompt)、maxTurns=6、工具白名单 read_file/list_dir、每任务独立会话、seed=1/2/3、执行顺序按 seed 洗牌。
- **配对**:同题三臂;(task,arm) 对在每个 seed 内洗牌执行,消除时间漂移混杂。
- **主终点**:protect 集 C vs A 任务成功率差(任务级配对 bootstrap 95% CI + 逐 seed 精确 McNemar)。
- **晋升门(先冻结)**:95% CI 排除零 或 任一 seed McNemar p<0.05;且保护集回退 ≤3pp;且总 token 增幅 ≤10%。
- **null/control**:A 臂协议完整重复 3 次(phase0,先于 B/C 任何数据),估计采样波动(幻影增益校准);phase3 的 A 臂重跑(不与 phase0 混用),保证主比较同窗执行。
- **崩溃规则**:crash 按任务失败计入主分析,单独报告崩溃率。

## 三、实现

- 纯逻辑:\`packages/evolution/src/three-arm.ts\`(任务抽样/判定器/注入构造/统计/晋升门常量);测试 \`packages/evolution/src/__tests__/three-arm.test.ts\`(15 用例:判定器各模式、fence、虚假完成、抽样确定性、hash 内容敏感、注入形态、McNemar 已知值、bootstrap、门行为、null 波动)。
- 驱动:\`scripts/three-arm-experiment.mts\`(setup/phase0/phase1/phase2/phase3,可断点续跑);分析:\`scripts/three-arm-analyze.mts\`。
- 保护集纪律:protect/ 目录文件设只读(0o444),phase0/2/3 前后指纹断言;phase1 输入过滤 holdoutClass==='train';门控 home(gate-home)不含保护集任务。

## 四、实际执行命令与原始结果

\`\`\`bash
npx tsx scripts/three-arm-experiment.mts setup    # 冻结 manifest + datasetHash
npx tsx scripts/three-arm-experiment.mts phase0   # null:A × (train+protect) × 3 seeds
npx tsx scripts/three-arm-experiment.mts phase1   # 候选生成(冻结 meta-model,train-only 失败)
npx tsx scripts/three-arm-experiment.mts phase2   # 真实 evolution 门控
npx tsx scripts/three-arm-experiment.mts phase3   # A/B/C × (train+protect) × 3 seeds(洗牌)
npx tsx scripts/three-arm-analyze.mts             # 统计判定 + 本报告
\`\`\`

- phase0(null):${nullRecords.length} 条记录;train 翻转率 ${pct(flux.train.flipRate)}(${flux.train.flippedTaskIds.length}/${flux.train.tasks} 题),protect 翻转率 ${pct(flux.protect.flipRate)}(${flux.protect.flippedTaskIds.length}/${flux.protect.tasks} 题)。翻转题(采样/执行波动带):${JSON.stringify(flux.train.flippedTaskIds.concat(flux.protect.flippedTaskIds))}
- phase1 候选:${candidate.candidate ? `\`${candidate.candidate.name}\`(sha256 ${candidate.candidateSha?.slice(0, 16)}…)` : '(生成失败)'}
- phase2 门控:${gate?.outcome ? `${gate.outcome.action}——${gate.outcome.reason.slice(0, 200)}` : '(未运行)'}
- phase3:共 ${mainRecords.length} 条记录(${cDeployable ? 'C 臂已部署' : `C 臂未部署(${cPlaceholderCount} 条占位)`});预测调用 ${predictions.size} 次(arm-blind)。

## 五、统计判定(每臂成功率 + CI + 配对检验 + 成本)

### 每臂成功率(主分析:crash 计为失败)

| 臂 | train | protect | 全部 | 崩溃率 | token 合计 | 平均墙钟 | 工具调用 | 恢复 | 虚假完成 | Brier |
|---|---|---|---|---|---|---|---|---|---|---|
| A | ${pct(stats['A:train']!.rate)} (${stats['A:train']!.pass}/${stats['A:train']!.runs}) | ${pct(stats['A:protect']!.rate)} (${stats['A:protect']!.pass}/${stats['A:protect']!.runs}) | ${pct(stats['A:all']!.rate)} | ${pct(stats['A:all']!.crashRate)} | ${stats['A:all']!.tokens ?? 'null'} | ${stats['A:all']!.wallMsAvg}ms | ${stats['A:all']!.toolCalls} | ${stats['A:all']!.recoveries} | ${stats['A:all']!.falseCompletion} | ${stats['A:all']!.brier ?? 'null'} |
| B | ${pct(stats['B:train']!.rate)} (${stats['B:train']!.pass}/${stats['B:train']!.runs}) | ${pct(stats['B:protect']!.rate)} (${stats['B:protect']!.pass}/${stats['B:protect']!.runs}) | ${pct(stats['B:all']!.rate)} | ${pct(stats['B:all']!.crashRate)} | ${stats['B:all']!.tokens ?? 'null'} | ${stats['B:all']!.wallMsAvg}ms | ${stats['B:all']!.toolCalls} | ${stats['B:all']!.recoveries} | ${stats['B:all']!.falseCompletion} | ${stats['B:all']!.brier ?? 'null'} |
| C | ${pct(stats['C:train']!.rate)} (${stats['C:train']!.pass}/${stats['C:train']!.runs}) | ${pct(stats['C:protect']!.rate)} (${stats['C:protect']!.pass}/${stats['C:protect']!.runs}) | ${pct(stats['C:all']!.rate)} | ${pct(stats['C:all']!.crashRate)} | ${stats['C:all']!.tokens ?? 'null'} | ${stats['C:all']!.wallMsAvg}ms | ${stats['C:all']!.toolCalls} | ${stats['C:all']!.recoveries} | ${stats['C:all']!.falseCompletion} | ${stats['C:all']!.brier ?? 'null'} |

### 主终点(预注册:protect 集 C vs A)

${fmtCmp(mainCmp, '【主终点】')}

### 探索性比较(不设晋升门,仅报告)

${exploratory.map((c) => fmtCmp(c, '(探索性)')).join('\n\n')}

### 成本门

- A 臂总 token:${tokA};C 臂总 token:${tokC};增幅 ${Number.isNaN(costGrowth) ? 'null(数据不足)' : pct(costGrowth)}(门限 ≤10%)。

### 晋升门判定

${gateResult.gates.length ? gateResult.gates.map((g) => `- [${g.pass ? 'PASS' : 'FAIL'}] ${g.name}——${g.detail}`).join('\n') : '(无:见 NEEDS-DATA)'}

**判定:${verdictText[gateResult.verdict] ?? gateResult.verdict}**

### 失败案例(逐题,seed:task)

- protect 集 C 赢/A 输(${analysis.disagreements['C-vs-A-protect']!.xWon.length}):${JSON.stringify(analysis.disagreements['C-vs-A-protect']!.xWon)}
- protect 集 A 赢/C 输(保护回退,${analysis.disagreements['C-vs-A-protect']!.aWon.length}):${JSON.stringify(analysis.disagreements['C-vs-A-protect']!.aWon)}
- protect 集 B 赢/A 输(${analysis.disagreements['B-vs-A-protect']!.xWon.length}):${JSON.stringify(analysis.disagreements['B-vs-A-protect']!.xWon)}
- protect 集 A 赢/B 输(${analysis.disagreements['B-vs-A-protect']!.aWon.length}):${JSON.stringify(analysis.disagreements['B-vs-A-protect']!.aWon)}
- train 集 C 赢/A 输(${analysis.disagreements['C-vs-A-train']!.xWon.length}):${JSON.stringify(analysis.disagreements['C-vs-A-train']!.xWon)}

## 六、NEEDS-DATA 清单

${[...(cDeployable ? mainCmp.needsData : ['C 臂不可部署(门控拒绝全部候选版本)——主终点无 C 臂数据']), ...(!cDeployable ? [] : []), ...(Number.isNaN(costGrowth) ? ['成本门数据不足(token 计数缺失)'] : []), ...(stats['C:all']!.brier === null && stats['A:all']!.brier === null ? ['Brier 无数据(预测解析失败或缺失)'] : []), ...(['真实用户轨迹分层:本实验无真实用户会话层(不适用,如实标注)'])].map((s) => `- ${s}`).join('\n')}

## 七、证据位置 / SHA / datasetHash

- 实验目录:\`website/evidence/experiments/three-arm-2026-10-27/\`
- manifest(预注册):\`manifest.json\`
- datasetHash:\`${manifest.frozen.taskSet.datasetHash}\`
- 候选 skill sha256:\`${candidate.candidateSha ?? 'null'}\`
- 逐 run 原始记录:\`phases/0-null.jsonl\`(${nullRecords.length} 行)、\`phases/3-main.jsonl\`(${mainRecords.length} 行);原始输出全文:\`phases/0-outputs/\`、\`phases/3-outputs/\`
- 保护集只读副本(\`${protectFileList.length}\` 文件):\`protect/\`
- 统计输出:\`analysis.json\`
- 门控完整报告:\`phases/2-gate.json\`

## 八、局限与回滚

- 局限:①pilot 规模(protect 23 题 × 3 seeds),小于门限的差异无法分辨(CI 宽度见上);②单一模型/单一提供商;③判定器对 fence 约定敏感(与仓库 bench 同构);④B 臂教训质量取决于 null 失败样本;⑤"真实用户"分层不适用本实验;⑥服务端模型状态漂移未受控(同日执行缓解)。
- 回滚:C 臂候选仅存在于实验目录与 gate-home(隔离副本),未写入真实 HMH_HOME 技能库;若部署后回退,删除 \`skills/active/<candidate>\` 即可(append-only 归档保留)。

## 九、下一步唯一建议

${gateResult.verdict === 'PROMOTE'
    ? '把候选以 canary 形态部署进真实 HMH_HOME(20% 会话注入),用既有 impact 循环(bench --impact)在生产会话上复验 30 天,再决定全量激活。'
    : gateResult.verdict === 'REJECT'
      ? '保持不部署;下一实验轮先把候选生成器升级为按失败类别分型的多候选(GEPA 种群),再进同一门控——单候选在这个语料上证据不足以下部署结论。'
      : '扩样本:protect 集扩到 ≥60 题、seed 扩到 5(预算 ~2×),重新跑同一预注册协议;不改门限。'}
`;

writeFileSync(join(EXP, 'report.md'), report, 'utf8');
console.log(`analysis written: ${join(EXP, 'analysis.json')}`);
console.log(`report written: ${join(EXP, 'report.md')}`);
console.log(`verdict: ${gateResult.verdict}`);
for (const g of gateResult.gates) console.log(`  [${g.pass ? 'PASS' : 'FAIL'}] ${g.name} — ${g.detail}`);
