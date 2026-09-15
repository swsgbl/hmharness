# ADR-0009: Pipeline Architecture Stage（V3 第四切片）

日期: 2026-09-15 · 状态: 已实施（0.14.6）

## 背景

蓝图 V3 DoD 链：产品需求→Planner→**Architecture**→Coder→Build→Device→Test→
Repair→Review→Judge→Release。现有 pipeline（ADR-0006）是 plan→code→test→review→
judge 五阶段，缺 Architecture 独立阶段。

## 决策

1. **agent/roles.ts 加 architect 角色**：charter = 结构决策（模块边界/数据流/
   接口契约/风险），不执行不写码。
2. **pipeline.ts 加 architecture 阶段**：在 plan 之后、code 之前执行一次
   `architect` 带契约的 runLoop，产出结构决策文本；code 阶段的 directive 携带
   plan+architecture 双上下文。
3. 预算纪律不变：architecture 阶段同样受 maxTurnsPerStage/maxTotalTurns 钳制。
4. 不做：自动架构图渲染、ADR 自动写盘——本切片只加角色与阶段。

## 后果

- `hmh pipeline` 现在走 plan→**arch**→code→test→review→judge 六阶段。
- 回滚：纯增量。
