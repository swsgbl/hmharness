# REPORT:三臂 v2 扩样本实验 three-arm-v2-2026-10-28(执行交付报告)

> 本文件是任务书要求的执行交付层(执行史/偏差/配额断点/commit 清单/复现)。
> 统计判定的机器生成全文见同目录 `report.md`(由 `scripts/three-arm-v2-analyze.mts` 产出,判定语言按预注册枚举,无手工修饰);结构化数字见 `analysis.json`。
> v2 接续 three-arm-main-experiment-2026-10-27 的 NEEDS-DATA 结论,执行其唯一下一步建议(protect ≥60 + 5 seeds + GEPA 分型种群),门限零改动。

## 一、结论摘要

**判定:NEEDS-DATA(主终点)。**

- **C 臂(持久进化)仍不可部署**:v2 把候选生成升级为按失败类别分型的 GEPA 式种群(phase0 train 失败分型出 format 类 14 题 / exact-output 类 3 题,每类并行生成 2 个双角度候选,共 4 个),全部进同一次仓库真实 evolution 门控(`runEvolution`,门限不变)——**4 候选全部被拒**,拒绝理由一致:"below quality floor (0.46 < 0.60)"(candidate train 通过率 46% = baseline 46%,零回归但零提升;绝对地板 0.6 拒绝弱基线下的无回归)。按预注册种群版 cArmRule,C 臂 505 格全部记录为 not-deployable 占位,主终点(protect 集 C-vs-A)无 C 臂数据。**结论比 v1 更进一步:v1 证明单候选不行,v2 证明"分型×多候选×双角度"的种群在这一门控下同样不行——瓶颈不在候选数量与覆盖面,而在生成内容质量 × 基线绝对水平的组合。这仍是持久进化路径的诚实结局,不是实验失败。**
- **B 臂(任务自适应,探索性)**:protect 集(69 题 × 5 seeds)81.45% vs A 81.16%(差 +0.29pp,bootstrap 95% CI [-0.87pp, +1.45pp],n=69 任务——扩样本后 CI 宽度从 v1 的 13.05pp 收窄到 2.32pp);train 集 56.25% vs 53.75%(差 +2.5pp,CI [-7.50pp, +11.88pp],n=32)。方向正向但 CI 均含 0,逐 seed McNemar 全部 p≥0.5——**不显著**;且 train +2.5pp 仍落在 null 波动带内(train 翻转率 9.4%)。
- **null 波动(幻影增益校准)**:phase0 五次重复中 train 翻转率 9.4%(3/32 题)、protect 翻转率 5.8%(4/69 题)——均比 v1(15.6%/17.4%)收窄,体现 5-seed 平均对采样波动的压制。
- **零 crash、零配额断流**:phase0 505 runs 与 phase3 1515 runs 全程无 API 崩溃、无 429;保护集指纹 `5778bdfb…`(脱敏导出后的新冻结值)与技能快照指纹 `085bcfff…` 在每个相前后一致;datasetHash `cd45058a…` 逐 run 一致。
- **工具修复交付**:实验导出管线内嵌用户名脱敏(发布钩子拦截的根因修复);v1 已冻结证据的清洁重导出旁路(`*-sanitized/` + `SANITIZATION.md`)已生成,原始数据零改动。

## 二、统计判定(摘要,全文见 report.md)

| 比较 | 成功率 | 任务级配对 bootstrap 95% CI | 逐 seed McNemar | 显著 |
|---|---|---|---|---|
| **C vs A @ protect(主终点)** | 无 C 臂数据(0 配对任务) | NaN(低支持度:<15 任务) | 无数据 | —(NEEDS-DATA) |
| B vs A @ protect(探索) | 81.45% vs 81.16% | [-0.87pp, +1.45pp](n=69) | p=0.5/1/0.5/0.5/0.5 | 否 |
| C vs A @ train(探索) | 无 C 臂数据 | NaN | 无数据 | —(NEEDS-DATA) |
| B vs A @ train(探索) | 56.25% vs 53.75% | [-7.50pp, +11.88pp](n=32) | p=1/1/0.625/1/1 | 否 |

成本(探索性):phase3 内 B 总 token 比 A 高 3.6%(1,490,099 vs 1,438,898);C 臂无 token 记录(占位)。

NEEDS-DATA 清单:① C 臂不可部署(门控拒绝全部 4 个种群候选)——主终点无 C 臂数据;② 成本门数据不足(C 臂无 token 记录);③ 真实用户轨迹分层不适用本实验(如实标注)。

## 三、逐相 commit 清单

| 相 | commit | 内容 |
|---|---|---|
| 工具修复 | `daaf102` | `packages/evolution/src/sanitize.ts`(参数化脱敏,8 测试)+ `scripts/sanitize-evidence.mts`(v1 清洁重导出生成器)+ v1 旁路(gate-home-sanitized/ 13 处、skills-snapshot-sanitized/ 5 处、manifest.sanitized.json、SANITIZATION.md;130 文件保真校验) |
| setup | `18359c1` | v2 预注册冻结:manifest(datasetHash `cd45058a…`)+ 三臂 v2 核心模块/测试(16 用例)+ 驱动;protect 69(23 hmb + 46 HarmonyBench 离线;8 needsTools 排除)+ train 32(与 v1 逐字节同选择)+ 脱敏快照(34 技能,5 文件洗)+ 脱敏 gate-home |
| 驱动韧性 | `6d16b3e` | 429 停相边界(不污染数据);门控 429 哨兵(INVALID 标记) |
| phase0 | `38cbe66` | null 505 runs(train 86/160=53.8%、protect 278/345=80.6%;token 1,442,874;505 predictions) |
| phase1 | `7d3a114` | 分型种群:format 14 题 + exact-output 3 题 → 4 候选(每类 2,双角度),全部过 poisoning screen,prompt sha 留痕 |
| phase2 | `c7fa487` | 门控:4 候选全拒(below quality floor 0.46<0.60;candidate=baseline=46%,零回归零提升);cArmRule 生效 |
| phase3 | `805445e` | 主实验 1515 runs:零 crash,A 366/505、B 371/505、C 505 占位;token A 1,438,898 / B 1,490,099 |
| phase4 | (本 commit) | analysis.json + report.md + REPORT.md |

## 四、执行偏差记录(全部留痕,未作任何现场改参数)

1. **gate-home beh-* 任务因脱敏而对称失效**(预注册 knownBehaviors 第 2 条,发生了):beh-echo 类任务 prompt 引用的绝对路径被洗为 `<user>` 占位,read_file 在门控内不可解析——baseline 与 candidate 双侧同样失这些题,方向保守。本轮 gate baseline train 46%(v1 未脱敏时 53.8%),弱化了基线,也使 0.6 绝对地板更难过。这是"发布钩子根因修复"的已知代价,预注册在先。
2. **分型只激活 2/5 类**:tool-use、forbidden、content-marker 三类在 phase0(5 seeds)中无失败成员(beh 族全过、none-marker 类全过)——种群实为 4 候选而非规则上限 10。如实:分型规则不造空类。
3. **gate 阶段无 token 细粒度**(继承 v1 偏差 4):runEvolution 内部 bench 不落盘 token。
4. **token 总量超任务书预计**:主实验相合计 4,371,871(phase0 1,442,874 + phase3 A/B 2,928,997),超出预计 2.5-3M——源于 protect 69 题 × 5 seeds 的组合(设计本身的代价)。零 429,单窗口跑完,未触发跨窗续跑纪律。
5. **manifest.repoCommit 与数据 commit 不同**:manifest 冻结于 `daaf102`(setup 时 HEAD),phase0-3 数据记录各自执行时的 HEAD(`38cbe66`/`805445e`);其间仅有的代码变更是 6d16b3e(429 韧性,先于全部 phase 数据)。预注册参数零改动。
6. **v1 既有 flaky 测试**(非本实验偏差,留痕):`packages/evolution/src/__tests__/three-arm.test.ts` 的 bootstrap 用例用 `Math.random()` 构造输入,偶发失败(基线可复现);未动 v1 冻结代码。
7. **两处模型输出含真实用户名**(phase3):`3-outputs/1-B-hmb-know-tools-apilookup.txt`(4 处)与 `3-outputs/3-A-hmb-know-tools-apilookup.txt`(1 处)——该任务 `tools:false`,模型在自由文本里**幻觉自述**了"运行过的 dir 命令"(含本机绝对路径),并非真实工具调用。输出字节是判定对象,原始数据不改;已生成旁路 `*.sanitized.txt`(同 v1 清洁重导出模式),phase0/3 其余 1717 个证据文件零用户名命中。

## 五、配额断点说明

- **本轮无配额断流**:phase0~3 与门控全程零 429、零 crash;未触发"停在相边界"纪律(驱动已具备该能力:429 即抛错中止,中断格不记 crash 不记 null prediction,幂等续跑)。
- **token 用量**(逐 run 落盘):phase0 = 1,442,877 含 predictions;phase3 = 2,928,997(A 1,438,898 / B 1,490,099 / C 0);gate 4 候选与分型生成为 API 调用但无 token 落盘(偏差 3)。

## 六、局限与下一步

局限全文见 `report.md` 第八节(protect 域仍为知识/精确输出、非真实用户轨迹;单模型单提供商;判定器 fence 敏感;gate beh 任务对称失效弱化基线;B 臂对 protect 族无同族教训故 protect 上 B≡A 注入——如实报告)。

**下一步唯一建议**(与 report.md 第九节一致,NEEDS-DATA 路径):扩样本方向已执行完毕(69 protect × 5 seeds)且种群门控仍全拒——证据已把瓶颈定位在"生成器产出质量 × 门控基线绝对水平"的组合上,而非样本量或候选多样性。下一轮优先研究**门控基线本身的方差**(同一候选多次门控的晋升率波动、弱基线 46% 与地板 0.6 之间的结构性距离),其次才是带门控反馈的迭代演化(GEPA 反思循环)。继续无差别扩样本不改变本结论。

## 七、复现

```bash
git checkout <本 commit>
npx tsx scripts/three-arm-v2-experiment.mts setup    # 冻结 manifest + datasetHash(已入库,重跑会重建同参数)
npx tsx scripts/three-arm-v2-experiment.mts phase0   # null:A × (train 32 + protect 69) × 5 seeds
npx tsx scripts/three-arm-v2-experiment.mts phase1   # 失败分型 + 种群生成(冻结 meta-model,train-only)
npx tsx scripts/three-arm-v2-experiment.mts phase2   # 真实 evolution 门控(全种群一次进)
npx tsx scripts/three-arm-v2-experiment.mts phase3   # A/B/C × (train+protect) × 5 seeds(洗牌;C 占位)
npx tsx scripts/three-arm-v2-analyze.mts             # 统计判定 + report.md
npx tsx scripts/sanitize-evidence.mts <v1 实验目录>   # (工具)v1 冻结证据的清洁重导出旁路
```

驱动器幂等可续跑(逐格 done 集合);证据目录 append-only,重跑只追加不覆盖历史。候选为生成式(无采样参数非确定),复现的是协议与判定门,不是逐字节输出。
