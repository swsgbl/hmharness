# REPORT:三臂主实验 three-arm-main-experiment-2026-10-27(执行交付报告)

> 本文件是任务书要求的执行交付层(执行史/偏差/配额断点/commit 清单/复现)。
> 统计判定的机器生成全文见同目录 `report.md`(由 `scripts/three-arm-analyze.mts` 产出,判定语言按预注册枚举,无手工修饰);结构化数字见 `analysis.json`。

## 一、结论摘要

**判定:NEEDS-DATA(主终点)。**

- **C 臂(持久进化)不可部署**:三个候选版本(`exact-output-only` sha `8c514b78…` / `exact-output-reply` sha `aaa17732…` / `character-exact-replies` sha `1a2d8188…`)在仓库真实 evolution 门控(`runEvolution`)下**三轮全部被拒**——两次"bench regression on a previously passing case"、一次"below quality floor (0.50 < 0.60)"。按预注册 `cArmRule`,C 臂 165 格全部记录为 not-deployable 占位,主终点(protect 集 C-vs-A)无 C 臂数据。**这本身是持久进化路径的诚实结局,不是实验失败**:单候选生成器在该语料上的产出过不了本仓库自己的门。
- **B 臂(任务自适应,探索性)**:protect 集 84.1% vs A 84.1%(差 0.0pp,bootstrap 95% CI [-7.25pp, +5.80pp],n=23 任务);train 集 57.3% vs A 53.1%(差 +4.2pp,CI [-4.17pp, +14.58pp],n=32 任务)。方向正向但 CI 均含 0,逐 seed McNemar 全部 p≥0.5——**不显著**。
- **null 波动(幻影增益校准)**:phase0 三次重复中 train 翻转率 15.6%(5/32 题)、protect 翻转率 17.4%(4/23 题)——B 臂 +4.2pp 的 train 差异完全落在采样波动带内,不可宣称。
- **零 crash**:phase0 165 runs 与 phase3 495 runs 全程无 API 崩溃记录;保护集指纹 `a264d64e70ef…` 与技能快照指纹 `30479b49c763…` 在每个相前后均与冻结值一致。

## 二、统计判定(摘要,全文见 report.md)

| 比较 | 成功率 | 任务级配对 bootstrap 95% CI | 逐 seed McNemar | 显著 |
|---|---|---|---|---|
| **C vs A @ protect(主终点)** | 无 C 臂数据(0 配对任务) | NaN(低支持度:<15 任务) | 无数据 | —(NEEDS-DATA) |
| B vs A @ protect(探索) | 84.1% vs 84.1% | [-7.25pp, +5.80pp] | p=1/1/1 | 否 |
| C vs A @ train(探索) | 无 C 臂数据 | NaN | 无数据 | —(NEEDS-DATA) |
| B vs A @ train(探索) | 57.3% vs 53.1% | [-4.17pp, +14.58pp] | p=1/1/0.5 | 否 |

NEEDS-DATA 清单:① C 臂不可部署(门控拒绝全部候选版本)——主终点无 C 臂数据;② 成本门数据不足(C 臂无 token 记录);③ 真实用户轨迹分层不适用本实验(如实标注)。

## 三、逐相 commit 清单

| 相 | commit | 内容 |
|---|---|---|
| setup(补提交) | `0799942` | manifest(datasetHash `d8e69089…`/快照指纹 `30479b49…`)+ protect 只读副本(`a264d64e70ef…`)+ gate-home + 34 技能快照 + design/reproduce |
| phase0(补提交) | `a4ffc36` | null 对照 165 runs(pass 104/fail 56 含 crash 5,token 487,577)+ predictions 165 条 + attic-baseline-mismatch 首轮作废归档 |
| analyze 清理 | `395a15f` | 前序遗留的分析器无害清理(不改判定逻辑) |
| phase1 | `56a538a` | 候选生成 attempt1(`exact-output-only`);强制补入库 phase0/phase1 日志(根 `.gitignore` `*.log` 误伤证据日志) |
| phase2 attempt1 | `1ea03d7` | 门控拒绝(train 50.0% vs baseline 53.8%,cjk-ex-12 单题回退);attempt1 产物归档 `*.attempt1.json` |
| phase2 attempt2 | `65cb835` | 门控拒绝(below quality floor 0.50<0.60;baseline 本轮亦波动至 50%);归档 `*.attempt2.json` |
| phase2 attempt3 | `d6d34dc` | 门控拒绝(再次 bench regression);三轮全拒 → cArmRule 生效;归档 `*.attempt3.json` |
| phase3 | `43ac320` | 主实验 495 runs:零 crash,A 109/165、B 113/165、C 165 占位;token 1,039,307;双指纹与冻结一致 |
| phase4 | (本 commit) | analysis.json + report.md + REPORT.md |

## 四、执行偏差记录(全部留痕,未作任何现场改参数)

1. **首轮 phase0 作废**(前序已处理,b292679):49 条 A 臂记录因驱动快照描述提取与 `skills.ts#parseDescription` 不一致作废,归档于 `phases/attic-baseline-mismatch/`(留痕不删除),phase0 从零重跑。
2. **gate 评测集被 `seedCases` 扩至 35 题**(26 train + 9 holdout):`runEvolution` 第一步 `seedCases(home)` 自动补种 3 个 starter case(`toolchain-report`/`reply-determinism`/`toolchain-ohpm-status`),而 setup 只预置了 32 个 train 任务。manifest 预注册记录为 `gateValSize: 8`。影响评估:baseline 与 candidate 在**同一** 35 题集上评测(对称);其中 2 个需活工具链的任务(`tools: loop` 但实验工具白名单仅 read_file/list_dir)对两侧对称必败,只可能让晋升更难(质量地板 0.6 为绝对值),**方向保守、不构成事后放宽**;主实验 phase0/phase3 任务集与 datasetHash 不受影响。三轮门控结论均在该集上得出并留痕(`phases/2-gate*.json`)。
3. **phase3.log 不完整**:驱动进程在后台外壳被 harness 时限杀死后作为孤儿进程继续跑完全部 495 格(数据写盘正常),但 tee 管道已断,日志仅存前 199 条。数据完整性以 `phases/3-main.jsonl`(495 条、495 唯一 key、datasetHash 一致)与重验的双指纹为准。
4. **gate 阶段无 token 细粒度记录**:`runEvolution` 内部 bench 不落盘 token 用量(仅主实验相落盘)。如实标注于 NEEDS-DATA 相关说明。

## 五、配额断点说明

- **前序断点**:上一轮于 19:42 配额断电,发生于 phase0 完成并通过 protect 指纹断言之后、commit 之前——本轮核实后零 API 幂等复验(165/165 done,指纹一致)并补提交,未重跑任何相。
- **本轮无配额断流**:phase1~3 及三轮门控全程零 429、零 crash;未触发"停在相边界"纪律。
- **token 用量**(主实验相,逐 run 落盘):phase0 = 487,577;phase3 = 1,039,307(A 513,553 / B 525,754 / C 0)。gate 三轮与候选生成为 API 调用但无 token 落盘(见偏差 4)。

## 六、局限与下一步

局限全文见 `report.md` 第八节(pilot 规模、单模型单提供商、判定器 fence 敏感、B 臂教训质量、无真实用户分层、服务端状态漂移同日缓解)。

**下一步唯一建议**(与 report.md 第九节一致,NEEDS-DATA 路径):扩样本——protect 集扩到 ≥60 题、seed 扩到 5(预算 ~2×),重新跑同一预注册协议,不改门限;同时把候选生成器升级为按失败类别分型的多候选(GEPA 种群)再进同一门控——三轮单候选全拒表明该方向才是瓶颈。

## 七、复现

```bash
git checkout <本 commit>
npx tsx scripts/three-arm-experiment.mts setup    # 冻结 manifest + datasetHash(已入库,重跑会重建同参数)
npx tsx scripts/three-arm-experiment.mts phase0   # null:A × (train+protect) × 3 seeds
npx tsx scripts/three-arm-experiment.mts phase1   # 候选生成(冻结 meta-model,train-only 失败)
npx tsx scripts/three-arm-experiment.mts phase2   # 真实 evolution 门控(可重复 3 次尝试:重跑 phase1→phase2)
npx tsx scripts/three-arm-experiment.mts phase3   # A/B/C × (train+protect) × 3 seeds(洗牌)
npx tsx scripts/three-arm-analyze.mts             # 统计判定 + report.md
```

驱动器幂等可续跑(逐格 done 集合);证据目录 append-only,重跑只追加不覆盖历史。候选为生成式(无采样参数非确定),复现的是协议与判定门,不是逐字节输出。
