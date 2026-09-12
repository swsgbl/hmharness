# ADR-0004: Trajectory Dataset + Shadow Model Router（V2 M10）

日期: 2026-09-13 · 状态: 已实施（0.9.0）

## 背景

蓝图 M10：Dataset（Trajectory→Filter→Deduplicate→Label→Evidence Attach→Reward→
Dataset Version→Train/Eval Split）与 Adaptive Model Router（Task Features→
Router→Model→Evaluation→Routing Outcome）。轨迹已在 HMH_HOME/runs/<id>/
（M1）；评测证据阶梯已定（M2）。

## 决策

1. **evolution/dataset.ts（纯数据工程，零模型调用）**：扫描 runs/ 轨迹 →
   filter（丢弃无 outcome/无 turns 的残缺轨迹）→ dedupe（task+outcome+
   turns+tools 指纹，保留最新）→ label（outcome/turns/toolFailRate/evidence）→
   reward（可解释映射：ok=1.0 基准，按工具失败率线性扣减；error/turn-budget
   封顶 0.3；llmJudge 结果永不给满分——M2 硬顶一致）→ 版本化落盘
   （`evolution/datasets/<ver>/manifest.json + samples.jsonl`，manifest 记录
   来源 run 区间/过滤器指纹/切分种子）→ train/eval 8:2 切分（确定性种子，
   eval 段即 M11 要求的 holdout set）。**导出即脱敏**：samples 过一遍
   redactSecrets（evidence 页教训）。
2. **kernel/router.ts = shadow router**：`extractFeatures(task)`（complexity
   启发式：长度/动词/多步信号；language；domain=harmony/generic）+
   `routeDecision(features, cfg)` 纯函数建议（不改变现有静态 routing）——
   runner 每次 run 记录一条 `routing.outcome`（任务特征+当前路由+建议路由）
   到 `evolution/routing.jsonl`。**先积累数据，统计显著后再启用**（蓝图 P1
   "Adaptive Router"与 M9 晋升门同一纪律：影子先行，门禁切换）。
3. **不训练任何模型**：M10 只交付"可导出的数据集版本"与"路由决策日志"，
   训练是 M11 门通过之后的事。

## 后果

- `hmh dataset build|list|show`、`hmh route stats` 两条 CLI。
- 回滚：模块纯增量，删除两个文件+CLI 分支即回 0.8.4。
