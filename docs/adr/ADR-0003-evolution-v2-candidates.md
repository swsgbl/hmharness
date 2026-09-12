# ADR-0003: Evolution V2 候选泛化（V2 M9）

日期: 2026-09-13 · 状态: 已实施（0.8.4）

## 背景

V2 蓝图 M9 把自进化从"技能提案"泛化为七类候选（prompt/skill/context/
tool_policy/model_router/workflow/harness），实验流程 Candidate→Safety Gate→
Offline Evaluation→Control/Treatment→Statistical Comparison→Canary→Promotion/
Rollback。现有 evolve.ts 只走技能单通道。

## 决策

1. **evolution/src/candidates.ts**：`EvolutionCandidate` schema 按蓝图逐字段
   （id/target/baseVersion/candidateVersion/hypothesis/expectedMetric + payload）。
   注册即毒检（复用 screenForPoison，防提示注入进候选池）。
2. **实验运行器是契约而非实现**：`ArmRunner(c, 'control'|'treatment')` 由调用方
   注入（离线 bench 案例逐条跑双臂）；candidates.ts 只负责调度、统计、判定、
   报告落盘（`evolution/experiments/<candId>/<ts>.json`）。holdout 案例排除在
   门禁外（与 bench.ts 一致）。
3. **统计判定**：双比例双侧正态近似 z 检验（A&S 26.2.17 CDF 近似）；判据与
   impact.ts 口径一致——每臂 <8 样本 needs-data；p<0.05 且 diff≥+10% 才
   promote-eligible；显著负向或 diff≤-10% reject。**一次成功不构成统计显著**
   由检验本身保证。
4. **晋升/回滚是带门禁的状态机，不是函数调用**：
   - `promoteCandidate` 必须存在 verdict=promote-eligible 的实验报告，否则拒绝
     （无 baseline 不晋升）；
   - 激活前把当前 active 指针存为 `<target>.previous.json`（无 rollback 不
     promotion）；
   - skill 目标复用既有 promoteSkill（金丝雀通道）；prompt/harness 目标若
     origin=agent 则拒绝——**生产 Agent 不得自改生产 Prompt**，需
     `approvedByHuman` 显式人工标记；
   - `rollbackCandidate` 恢复 previous 指针或 rollbackSkill。
5. **诚实边界**：context/model_router 等目标的注入点尚未接到运行时，注册与
   实验可跑（ArmRunner 可模拟），但 active 指针暂无消费方——版本登记簿先行，
   消费接线属 M10。CLI：`hmh experiment list|show|run <id>`。

## 后果

- 自进化的"什么在被进化"从隐式（技能文件）变成显式版本化登记。
- LLM self-report 在整条链路上无晋升效力（M2 证据阶梯 + 本 ADR 双保险）。
- 回滚方案：模块纯增量；删除 candidates.ts + CLI 分支即回到 0.8.3。
