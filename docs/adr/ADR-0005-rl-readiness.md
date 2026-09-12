# ADR-0005: RL 前置条件检查器（V2 M11）

日期: 2026-09-13 · 状态: 已实施（0.9.0）

## 背景

蓝图 M11：RL 只在六个条件全满足时进入（≥1000 高质量轨迹、≥100 稳定
benchmark 任务、reward 与人工判断相关性已验证、评估回归套件稳定、版本
可追溯、存在 offline evaluation+holdout）。**否则优先做 Skill/Prompt/
Router Optimization**。这条规则的价值在于"明确说不"——防止在数据不成熟
时烧钱训练。

## 决策

1. **evolution/readiness.ts**：`rlReadiness(home)` 聚合真实数据逐条判定，
   每条条件输出 {met, current, threshold, evidence}——证据可审计（counts
   来自 runs/、bench/cases/、datasets/、experiments/ 的实际扫描），不做任何
   估算式放水。
2. **reward-人工相关性**：当前无人工标注通道 → 如实报 not-met（M10 的
   dataset 标注管线的 label 字段为未来人工校准预留）；**评估回归套件稳定**
   定义为最近两次 bench 运行用例集无回归（benches/ 记录对比）。
3. **结论即路由**：`verdict = all(met) ? 'rl-eligible' : 'optimize-first'`
   ——optimize-first 时报告明示应做哪类优化（skill/prompt/router，按当前
   最弱条件映射）。`hmh readiness` 输出报告，不提供任何"强制进入 RL"的
   开关——蓝图红线没有绕行路径。

## 后果

- V2 蓝图全部里程碑（M0-M11）闭合；V3（Agent OS：产品需求→Planner→…→
  Release 全链路）按 181-365 天路线推进，不在本轮。
- 回滚：纯增量模块。
