/**
 * Three-arm v2 experiment analysis (phase 4). Reads ONLY what phases 0-3
 * wrote into the v2 evidence dir; emits analysis.json + report.md. Verdict
 * language is enumerated from the pre-registered gate — no post-hoc wording,
 * no number editing. Same discipline as the v1 analyzer.
 * Run: npx tsx scripts/three-arm-v2-analyze.mts
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPERIMENT_ID_V2, SEEDS_V2, compareArmsV2,
} from '../packages/evolution/src/three-arm-v2.ts';
import { evaluateGate, nullFlux, type RunRecord } from '../packages/evolution/src/three-arm.ts';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXP = join(REPO_ROOT, 'website', 'evidence', 'experiments', 'three-arm-v2-2026-10-28');
const PHASES = join(EXP, 'phases');

const manifest = JSON.parse(readFileSync(join(EXP, 'manifest.json'), 'utf8')) as {
  frozen: { taskSet: { datasetHash: string; train: { counts: number }; protect: { hmbHoldout: { counts: number }; harmonybench: { counts: number }; total: number } } };
};
const nullRecords = loadJsonl('0-null.jsonl');
const mainRecords = loadJsonl('3-main.jsonl');
const predictions = loadPredictions();
const candidates = JSON.parse(readFileSync(join(PHASES, '1-candidates.json'), 'utf8')) as {
  population: Array<{ name: string; failureClass: string; candidateSha: string }>;
  gateOutcome?: { ranAt: string; promoted: string[]; rejected: string[]; deployedChoice?: { name: string; rule: string } };
};
const gate = existsSync(join(PHASES, '2-gate.json'))
  ? JSON.parse(readFileSync(join(PHASES, '2-gate.json'), 'utf8')) as { ranAt: string; INVALID?: string; report?: { outcomes?: Array<{ name: string; action: string; reason: string; candidate?: { passRate: number } }> } }
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

const cDeployable = !mainRecords.some((r) => r.reason.startsWith('C-arm not deployable')) && candidates.gateOutcome?.deployedChoice !== undefined;
const cPlaceholderCount = mainRecords.filter((r) => r.reason.startsWith('C-arm not deployable')).length;

const primary = asPrimary(mainRecords);

/* ---- rates + secondary metrics per arm/split ---- */
interface ArmStats { runs: number; pass: number; rate: number; tokens: number | null; wallMsAvg: number; toolCalls: number; recoveries: number; crashes: number; falseCompletion: number; brier: number | null; crashRate: number }
function armStats(rs: RunRecord[], arm: string, split?: 'train' | 'protect'): ArmStats {
  const sel = rs.filter((r) => r.arm === arm && (split === undefined || r.holdoutClass === split));
  const tok = sel.reduce((s, r) => s + (r.metrics.cost.totalTokens ?? 0), 0);
  const briers = sel.filter((r) => r.metrics.brier !== null);
  return {
    runs: sel.length,
    pass: sel.filter((r) => r.outcome.success === true).length,
    rate: sel.length ? Number((sel.filter((r) => r.outcome.success === true).length / sel.length).toFixed(4)) : 0,
    tokens: tok > 0 ? tok : null,
    wallMsAvg: sel.length ? Math.round(sel.reduce((s, r) => s + r.metrics.wallMs, 0) / sel.length) : 0,
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

/* ---- the four comparisons (main + 3 exploratory), 5 seeds ---- */
const mainCmp = compareArmsV2(primary, 'C', 'A', 'protect', SEEDS_V2);
const exploratory = [
  compareArmsV2(primary, 'B', 'A', 'protect', SEEDS_V2),
  compareArmsV2(primary, 'C', 'A', 'train', SEEDS_V2),
  compareArmsV2(primary, 'B', 'A', 'train', SEEDS_V2),
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
  : { verdict: 'NEEDS-DATA' as const, gates: [], reason: cDeployable ? 'no C-arm records' : 'C arm not deployable: the evolution gate rejected the ENTIRE candidate population (v2 GEPA-style population rule — the honest outcome of the persistent-evolution path)' };

/* ---- per-task disagreement tables ---- */
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

/* ---- population / gate summary ---- */
const popByClass: Record<string, string[]> = {};
for (const p of candidates.population) popByClass[p.failureClass] = [...(popByClass[p.failureClass] ?? []), p.name];
const gateOutcomes = gate?.report?.outcomes ?? [];

const analysis = {
  experimentId: EXPERIMENT_ID_V2,
  generatedAt: new Date().toISOString(),
  datasetHash: manifest.frozen.taskSet.datasetHash,
  cDeployable,
  cPlaceholderCount,
  population: { size: candidates.population.length, byClass: popByClass, gatePromoted: candidates.gateOutcome?.promoted ?? [], gateRejected: candidates.gateOutcome?.rejected ?? [], deployedChoice: candidates.gateOutcome?.deployedChoice ?? null },
  stats,
  mainEndpoint: mainCmp,
  exploratory,
  nullFlux: flux,
  cost: { tokensA: tokA, tokensB: tokensOf('B'), tokensC: tokC, costGrowth: Number.isNaN(costGrowth) ? null : costGrowth },
  gate: gateResult,
  disagreements: {
    'C-vs-A-protect': disagreements('C', 'protect'),
    'B-vs-A-protect': disagreements('B', 'protect'),
    'C-vs-A-train': disagreements('C', 'train'),
  },
  predictions: { count: predictions.size },
};
writeFileSync(join(EXP, 'analysis.json'), JSON.stringify(analysis, null, 2) + '\n', 'utf8');

/* ================= report.md (delivery template, v1 structure) ================= */
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pp = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}pp`;
const fmtCmp = (c: typeof mainCmp, exploratoryNote: string) => {
  const m = c.mcnemarPerSeed.map((s) => `seed${s.seed}: ${s.xOnly}/${s.yOnly} discordant, p=${s.p}`).join('; ');
  return [
    `#### ${c.comparison} @ ${c.split} ${exploratoryNote}`,
    `- 成功率: ${c.armX} ${pct(c.rateX)} vs ${c.armY} ${pct(c.rateY)}(差 ${pp(c.diff)})`,
    `- 任务级配对差 bootstrap 95% CI: [${pp(c.bootstrap.ciLo)}, ${pp(c.bootstrap.ciHi)}](宽度 ${pp(c.bootstrap.width)}, n=${c.bootstrap.nTasks} 任务)`,
    `- 逐 seed 精确 McNemar: ${m}`,
    `- 显著(预注册标准): ${c.significant ? '是' : '否'}${c.needsData.length ? `;低支持度: ${c.needsData.join('; ')}` : ''}`,
  ].join('\n');
};

const protectFileList = readdirSync(join(EXP, 'protect')).sort();
const verdictText: Record<string, string> = {
  PROMOTE: `**PROMOTE**——种群胜者通过全部预注册晋升门(显著性 + 保护集回退 ≤3pp + 成本增幅 ≤10%)。C 臂的持久化改动在冻结 base model 下提高了保护集任务成功率且未破坏保护任务。`,
  REJECT: `**REJECT**——种群胜者未通过预注册晋升门:${gateResult.reason}。按门控纪律,该改动不得持久化部署。`,
  'NEEDS-DATA': `**NEEDS-DATA**——${gateResult.reason}`,
};

const gateOutcomesLines = gateOutcomes.map((o) => `- \`${o.name}\` → **${o.action}**:${o.reason.slice(0, 220)}${o.candidate ? `(gate train ${(o.candidate.passRate * 100).toFixed(0)}%)` : ''}`).join('\n');

const report = `# 三臂 v2 扩样本实验报告:${EXPERIMENT_ID_V2}

> 研究问题:一项可持久化的 harness/skill 改动在冻结 base model 下是否提高任务成功率且不破坏保护任务。
> v2 接续 three-arm-main-experiment-2026-10-27 的 NEEDS-DATA 结论,执行其唯一下一步建议:protect 扩到 69 题(23 hmb holdout + 46 HarmonyBench 离线题)、seeds 扩到 5、候选生成升级为按失败类别分型的 GEPA 式种群(每类 2 候选,全种群进同一次真实门控,门限不变)。
> 本报告由 scripts/three-arm-v2-analyze.mts 从 phases/ 落盘数据生成;判定语言按预注册枚举,无手工修饰。

## 一、事实 / 假设 / 缺证据

| 类别 | 内容 |
|---|---|
| **事实** | ① 任务集:train ${manifest.frozen.taskSet.train.count} 题(与 v1 逐字节同选择,同配额同 seed)+ protect ${manifest.frozen.taskSet.protect.total} 题(${manifest.frozen.taskSet.protect.hmbHoldout.count} hmb holdout + ${manifest.frozen.taskSet.protect.harmonybench.count} HarmonyBench v1.0.0 离线题;8 个 needsTools 题排除——冻结工具白名单无法服务,同 v1 toolchain-* 理由,预注册);② 三臂除注入物外一切冻结(provider=glm-5.3、无采样参数、同 system prompt 模板、maxTurns=6、只读工具 read_file/list_dir、每任务新会话、seeds=1..5、seed 内洗牌执行);③ 判定为程序化断言(exact/regex/none/any/contains),环境真值,不接受模型自述;④ 候选种群经仓库真实 evolution 门控(runEvolution:双采样、零回归、质量地板 0.6、成本帽、gate-val 复验)后才可部署;⑤ 全部证据导出经用户名脱敏(所跑即所发布)。 |
| **假设** | ① 服务端模型行为在实验窗口内稳定(跨窗口续跑时该假设减弱,断点已留痕);② glm-5.3 在相同 wire 请求(不发送采样参数)下行为一致;③ B 臂教训与种群候选仅来自 train 同族/同类失败(代码保证),无保护集泄漏。 |
| **缺证据** | ① 美元成本:glm coding plan 为包月(cost 记 token 数,usd=null);② gate 阶段 token 细粒度(runEvolution 内部 bench 不落盘,继承 v1 偏差);③ 除本机 bench 族 + HarmonyBench 外的泛化。 |

## 二、实验设计(预注册于 manifest.json,先于任何数据冻结)

- **三臂**:A=Baseline(冻结脱敏技能库快照原样注入);B=Task-adaptive(同快照 + 每任务临时适应块,train 同族 null 失败教训,任务后丢弃);C=Persistent-evolved(同快照 + 门控晋升的种群胜者,注入构造与门控期逐字节一致)。
- **v2 变更(vs v1)**:protect 23→69;seeds 3→5;候选生成从"单一候选三轮重试"升级为"失败分型(exact-output/format/content-marker/tool-use/forbidden 五类,detail 前缀 + toolCalls 信号确定性分型)→ 每类 2 候选 → 全种群(≤10)进同一次 runEvolution";晋升后胜者规则=gate train passRate 最高、平局名字典序最小。**门限与统计协议原样继承 v1,未调任何门限。**
- **主终点**:protect 集 C vs A 任务成功率差(任务级配对 bootstrap 95% CI,10k 重采样,种子固定 + 逐 seed 精确 McNemar,5 seeds)。
- **晋升门(先冻结,同 v1)**:95% CI 排除零 或 任一 seed McNemar p<0.05;且保护集回退 ≤3pp;且总 token 增幅 ≤10%。
- **cArmRule(v2 种群版,预注册)**:C 仅在种群有候选晋升时运行;种群全部被拒 ⇒ C 记 not deployable,主终点 NEEDS-DATA(诚实结局,非实验失败)。
- **null/control**:A 臂协议完整重复 5 seeds(phase0,先于 B/C 任何数据);phase3 的 A 臂重跑(同窗纪律)。
- **崩溃规则**:crash 按任务失败计入主分析,单独报告崩溃率。429 配额断流不记 crash 不记数据,停在相边界等窗口续跑。

## 三、实现

- 纯逻辑:\`packages/evolution/src/three-arm-v2.ts\`(v2 常量/分型/HarmonyBench 映射/种群规则/seeds 参数化统计;复用 v1 纯函数)+ \`packages/evolution/src/sanitize.ts\`(导出脱敏);测试 \`three-arm-v2.test.ts\`(8 用例)+ \`sanitize.test.ts\`(8 用例)。
- 驱动:\`scripts/three-arm-v2-experiment.mts\`(setup/phase0..3,幂等续跑,429 停相边界,门控 429 哨兵);分析:\`scripts/three-arm-v2-analyze.mts\`。
- 保护集纪律:protect/ 只读(0o444)+ 前后指纹断言;phase1 输入过滤 holdoutClass==='train';gate-home 不含 protect 任务。

## 四、实际执行命令与原始结果

\`\`\`bash
npx tsx scripts/three-arm-v2-experiment.mts setup    # 冻结 manifest + datasetHash(脱敏导出)
npx tsx scripts/three-arm-v2-experiment.mts phase0   # null:A × (train+protect) × 5 seeds
npx tsx scripts/three-arm-v2-experiment.mts phase1   # 失败分型 + 种群生成(冻结 meta-model,train-only)
npx tsx scripts/three-arm-v2-experiment.mts phase2   # 真实 evolution 门控(全种群一次进)
npx tsx scripts/three-arm-v2-experiment.mts phase3   # A/B/C × (train+protect) × 5 seeds(洗牌)
npx tsx scripts/three-arm-v2-analyze.mts             # 统计判定 + 本报告
\`\`\`

- phase0(null):${nullRecords.length} 条记录;train 翻转率 ${pct(flux.train.flipRate)}(${flux.train.flippedTaskIds.length}/${flux.train.tasks} 题),protect 翻转率 ${pct(flux.protect.flipRate)}(${flux.protect.flippedTaskIds.length}/${flux.protect.tasks} 题)。
- phase1 种群:${candidates.population.length} 个候选,按类:${Object.entries(popByClass).map(([k, v]) => `${k}=${v.length}`).join(', ')}。
- phase2 门控:晋升 [${candidates.gateOutcome?.promoted.join(', ') || '无'}],拒绝 [${candidates.gateOutcome?.rejected.join(', ') || '无'}]${candidates.gateOutcome?.deployedChoice ? `,部署胜者 \`${candidates.gateOutcome.deployedChoice.name}\`` : ',**无部署胜者——种群全拒,cArmRule 生效**'}。
- phase3:共 ${mainRecords.length} 条记录(${cDeployable ? 'C 臂已部署' : `C 臂未部署(${cPlaceholderCount} 条占位)`});预测调用 ${predictions.size} 次(arm-blind)。

### 门控逐候选结果(全种群)

${gateOutcomesLines || '(未运行)'}

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

- protect 集 C 赢/A 输(${analysis.disagreements['C-vs-A-protect']!.xWon.length}):${JSON.stringify(analysis.disagreements['C-vs-A-protect']!.xWon.slice(0, 60))}
- protect 集 A 赢/C 输(保护回退,${analysis.disagreements['C-vs-A-protect']!.aWon.length}):${JSON.stringify(analysis.disagreements['C-vs-A-protect']!.aWon.slice(0, 60))}
- protect 集 B 赢/A 输(${analysis.disagreements['B-vs-A-protect']!.xWon.length}):${JSON.stringify(analysis.disagreements['B-vs-A-protect']!.xWon.slice(0, 60))}
- protect 集 A 赢/B 输(${analysis.disagreements['B-vs-A-protect']!.aWon.length}):${JSON.stringify(analysis.disagreements['B-vs-A-protect']!.aWon.slice(0, 60))}
- train 集 C 赢/A 输(${analysis.disagreements['C-vs-A-train']!.xWon.length}):${JSON.stringify(analysis.disagreements['C-vs-A-train']!.xWon.slice(0, 60))}

## 六、NEEDS-DATA 清单

${[...(cDeployable ? mainCmp.needsData : [`C 臂不可部署(门控拒绝全部 ${candidates.population.length} 个种群候选)——主终点无 C 臂数据`]), ...(Number.isNaN(costGrowth) ? ['成本门数据不足(token 计数缺失)'] : []), '真实用户轨迹分层:本实验无真实用户会话层(不适用,如实标注)'].map((s) => `- ${s}`).join('\n')}

## 七、证据位置 / SHA / datasetHash

- 实验目录:\`website/evidence/experiments/three-arm-v2-2026-10-28/\`
- manifest(预注册):\`manifest.json\`
- datasetHash:\`${manifest.frozen.taskSet.datasetHash}\`
- 种群候选 sha256:\`phases/1-candidates.json\`(${candidates.population.map((p) => `${p.name}:${p.candidateSha.slice(0, 8)}…`).join(', ')})
- 逐 run 原始记录:\`phases/0-null.jsonl\`(${nullRecords.length} 行)、\`phases/3-main.jsonl\`(${mainRecords.length} 行);原始输出全文:\`phases/0-outputs/\`、\`phases/3-outputs/\`
- 保护集只读副本(\`${protectFileList.length}\` 文件,脱敏):\`protect/\`
- 统计输出:\`analysis.json\`;门控完整报告:\`phases/2-gate.json\`

## 八、局限与回滚

- 局限:① HarmonyBench protect 题与 hmb 族同属知识/精确输出域,仍非真实用户轨迹;② 单一模型/单一提供商;③ 判定器对 fence 约定敏感(与仓库 bench 同构);④ gate-home 内 beh-* 任务 prompt 经脱敏(路径含 <user> 占位,read_file 不可解析),门控两侧对称失败,信号降低(预注册 knownBehaviors);⑤ 跨配额窗续跑时服务端状态漂移窗口拉长(断点留痕);⑥ B 臂对 protect 族无同族教训(族不同),protect 上 B≡A 注入,如实报告。
- 回滚:C 臂候选仅存在于实验目录与 gate-home(隔离副本),未写入真实 HMH_HOME 技能库;删除 \`skills/active/<candidate>\` 即回退(append-only 归档保留)。

## 九、下一步唯一建议

${gateResult.verdict === 'PROMOTE'
    ? '把种群胜者以 canary 形态部署进真实 HMH_HOME(20% 会话注入),用既有 impact 循环(bench --impact)在生产会话上复验 30 天,再决定全量激活。'
    : gateResult.verdict === 'REJECT'
      ? '保持不部署;候选生成仍是瓶颈——下一轮把分型种群升级为带门控反馈的迭代演化(GEPA 反思循环:被拒候选的拒绝理由回流为下一代的祖先上下文),并考虑放宽种群规模上限换取更多变异。'
      : '扩样本方向已执行(69 protect × 5 seeds);若种群门控仍全拒,瓶颈已定位在"生成器产出质量 × 门控严格度"的组合——下一步优先研究门控基线本身的方差(同候选多次门控的晋升率波动),而非继续扩样本。'}
`;

writeFileSync(join(EXP, 'report.md'), report, 'utf8');
console.log(`analysis written: ${join(EXP, 'analysis.json')}`);
console.log(`report written: ${join(EXP, 'report.md')}`);
console.log(`verdict: ${gateResult.verdict}`);
for (const g of gateResult.gates) console.log(`  [${g.pass ? 'PASS' : 'FAIL'}] ${g.name} — ${g.detail}`);
