# ADR-0006: Pipeline Runtime — V3 首切片（V2 M12 方向）

日期: 2026-09-13 · 状态: 已实施（0.10.0）

## 背景

蓝图 V3 DoD：产品需求→Planner→Architecture→Coder→Build→Emulator/Device→
Test→Bug→Repair→Reviewer→Judge→Release 全链路。V2 已交付零件：六角色契约
（M7）、Project Runtime（M8）、评测门（M2）、沙箱（M3）、轨迹（M1）。
V3 首切片 = 把零件编排成一条**角色流水线**，先在 bench 案例与模拟器上闭环。

## 决策

1. **agent/pipeline.ts**：五阶段编排 plan→code→test→review→judge，每阶段是
   一次带 roleCharter（M7）的 runLoop 调用（不依赖 spawn 子进程——同进程
   顺序阶段，预算可控、轨迹连续）。judge 契约的 `VERDICT: PASS/FAIL` 结尾
   （M7 内嵌）是**唯一的阶段门**：FAIL 且 repair 次数未耗尽 → 把 judge 的
   具体问题清单回灌 code+test 两阶段重跑（repair 循环，默认上限 2）。
2. **非 LLM 阶段门优先**：test 阶段先跑机械断言（bench matchCase / 命令
   退出码），全绿则直接 PASS 进 review；LLM 只在需要判断语义时出场——
   M2 证据阶梯的顺序原则沿用到编排层。
3. **全程留痕**：每阶段的输入摘要/输出/VERDICT/时长写入 pipeline.report.json
   （HMH_HOME/pipelines/<id>/）+ Project Record（M8 attachRun 同款决策日志）；
   每阶段一次 runLoop 也自动产生 M1 轨迹（runs/ 不变）。
4. **预算门**：maxStages 总轮数预算（默认 24）+ 每阶段 maxTurns（默认 6），
   超预算流水线以 'budget' 状态收场——诚实失败优于静默膨胀。
5. **不承诺 V3 全图**：Emulator/Device 阶段、Release 阶段、多 Agent 并行
   属 V3 后续切片；本切片交付"文字任务 → 五角色裁决 → 修复循环"的骨架与
   真实证据。

## 后果

- `hmh pipeline "<task>"` 一条命令跑通全链路；bench 案例可复用同一入口。
- 回滚：纯增量模块（pipeline.ts + CLI 分支），删除即回 0.9.0。
