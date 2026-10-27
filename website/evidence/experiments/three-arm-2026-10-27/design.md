# 三臂主实验设计(预注册文档)

实验 ID:`three-arm-main-experiment-2026-10-27`(Issue #22,P1)
状态:本文件与 `manifest.json` 在**任何实验数据产生之前**写入并提交(manifestSha256 见下);此后 manifest 不可修改,各 phase 产物只追加。

## 研究问题

一项**可持久化的 harness/skill 改动**在冻结 base model 下是否提高任务成功率,且不破坏保护任务(protect holdout)。

## 三臂定义

| 臂 | 定义 | 持久化 |
|---|---|---|
| A Baseline | 冻结技能库快照原样注入,其余与 B/C 完全一致 | — |
| B Task-adaptive | A + 每任务临时适应块(train 同族 null 失败教训,≤3 条,确定性模板生成) | 任务后丢弃(每任务新会话,构造上即丢弃) |
| C Persistent-evolved | A + 候选 skill,仅当候选通过仓库真实 evolution 门控(runEvolution)后部署;注入构造与门控期逐字节一致 | 模拟已部署的持久化改动 |

三臂之间唯一差异 = 注入物(A 的快照基线之上,B 加适应块 / C 加候选)。

## 冻结清单(manifest.json `frozen` 节)

- base model:glm-5.3 @ `https://open.bigmodel.cn/api/coding/paas/v4`(zhipu coding plan);**不发送任何采样参数**(服务端默认),三臂 wire 形状一致。
- system prompt:`buildSystemPrompt`(packages/agent/src/prompt.ts),参数固定(cwd=repo root、memory/insights/cognitive 空、model=glm-5.3);无 locale/agentsMd/goal。
- maxTurns=6(tools 任务);非 tools 任务单次 chat。
- 工具白名单:`read_file`、`list_dir`(只读;无 shell、无网络工具)。
- 每任务独立新会话,无历史携带。
- seeds:1、2、3;每 seed 内 (task,arm) 执行顺序 seeded 洗牌(材料 `three-arm-main-experiment-2026-10-27:exec-order:{seed}`)。
- 任务集:本机 `~/.hmharness/bench/cases` 语料(115 .task = 91 train + 24 holdout 先例)分层抽样:
  - train 子集 32 题(族配额 beh 8、cjk 6、adv 6、train 6、fadv 3、teach 3;选择 seed 20261027);
  - protect 子集 23 题(全部 holdout,排除 `toolchain-ohpm-status`——需活工具链,环境不可冻结);
  - `toolchain-*`、`reply-determinism` 排除(同因)。
- datasetHash:`buildTaskSetHash`(canonical:任务按 id 排序,完整断言 spec 序列化进 evalset 的 assertion.expect,内容敏感)。
- 技能库快照:本机 `~/.hmharness/skills/active`(34 个),逐字节复制 + 指纹断言。
- 预测(次指标 Brier):arm-blind 固定 prompt,同冻结模型,每 (task,seed) 一次,三臂共用;解析失败记 null(不是 0)。

## 候选生成与门控(C 臂前置)

1. phase1:候选由冻结 glm-5.3 依固定 prompt 从 **train-only** null 失败摘要生成(全失败任务优先,≤20 条样本);过 `screenForPoison`;最多 3 次解析尝试。
2. phase2:候选进 `runEvolution`(presetProposals)真门控:双采样无回归、质量地板(minPassRate=0.6 默认,**未调低**)、成本帽(cost-cap 1.3 默认)、gate-val(train 子集 seeded 抽 8 题标 holdout)复验。被拒→携带拒绝原因重生成(≤3 版)。
3. 3 版全拒 → C 臂如实记为不可部署(主终点 NEEDS-DATA);**绝不**绕过门控强行注入。

## 数据分层与保护

| 层 | 位置 | 进化器可写? |
|---|---|---|
| 训练集(train 32) | phase0/phase3 记录 + gate-home | 是(仅 gate home 内) |
| 公开只读 | 本机 bench 语料 + 本目录 manifest/protect 副本 | 否 |
| 真实用户 | 不适用本实验(如实标注) | — |
| 隐藏 evaluator(protect 23) | `protect/`(0o444 只读)+ 指纹断言(phase0/2/3 前后) | **否,双重保证:文件权限 + 运行时断言** |

phase1 输入在代码层过滤 `holdoutClass==='train'`;gate home 不含 protect 任务。

## 主终点与晋升门(先冻结,后见数据)

- **主终点(唯一)**:protect 集 C vs A 任务成功率差。
- 显著性:任务级配对差 bootstrap 95% CI(10k 次,seeded 可复现)排除 0,**或**任一 seed 的精确 McNemar p<0.05。
- 晋升门 = 显著性 **且** 保护集回退(C−A 点估计)≥ −3pp **且** 总 token 增幅 ≤10%。
- 探索性(不设门,只报告):protect B vs A、train C vs A、train B vs A。
- 低支持度:配对任务 <15 或 discordant cells <8 → NEEDS-DATA。
- 崩溃:主分析按任务失败计,另报崩溃率。
- null/control:A 臂协议完整跑 3 次(phase0,先于一切 B/C 数据)估计采样/执行波动;phase3 的 A 臂重新执行(同窗配对),不与 phase0 混用。

## 主指标与次指标

- 主指标:环境真值任务成功率(程序化断言:expect-exact/regex/none/any + fence 约定;判定器有 15 用例单测)。**不接受模型自述。**
- 次指标:token 成本(usage 实测;usd=null 包月不可得)、墙钟、工具调用数、恢复次数(工具错误后 loop 继续)、崩溃率、虚假完成率(断言失败且输出含完成标记)、预测 Brier。

## 记录 schema

每 run 一行 JSON(`phases/*.jsonl`):experimentId / repoCommit / datasetHash / baseModel{provider,id,sampling} / arm / seed / taskId / holdoutClass / outcome{success,environmentDeltaHash} / metrics{cost{promptTokens,completionTokens,totalTokens,usd},wallMs,toolCalls,recoveries,crashes,falseCompletion,predictedP,brier} / safety{backend,isolationLevel} / decision / reason。**null 表示未测,不是 0。**

## 已知局限(预注册时声明)

pilot 规模;单一模型/提供商;fence 判定与仓库 bench 同构的敏感性;B 臂教训质量受 null 失败样本限制;无真实用户分层;服务端模型漂移未受控(同日执行缓解)。
