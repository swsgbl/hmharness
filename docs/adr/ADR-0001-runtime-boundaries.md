# ADR-0001: Runtime / Capability / Sandbox / Observability 所有权边界

- 状态: Accepted（2026-09-12）
- 基线: v2-foundation-baseline（0.6.8, 155+2 测试全绿）
- 依据: V2/V3 总体架构路线图 + 施工方案（2026-09-12）；
  外部验证：MCP 2026-07-28 规范（stateless core/Tasks/OAuth 2.1 RS）、
  OpenAI Agents SDK Sandbox 概念（runtime 拥有编排状态，sandbox 拥有执行环境）、
  Zed ACP、Microsoft Agent Lightning（harnessed agentic RL）。

## 决策

四层所有权，任何代码不得跨界持有：

| 层 | 拥有 | 现有落点 | V2 落点 |
|---|---|---|---|
| **Runtime**（kernel/agent） | agent 轮次、审批流、上下文、恢复状态 | kernel/loop.ts、agent/runner.ts | runtime 语义不变，增加事件发射 |
| **Capability**（能力面） | 工具/MCP/Skill/设备能力的声明与鉴权 | Tool.needsApproval + kernel/shellgate.ts | CapabilityManifest + Registry + PolicyEngine（M4） |
| **Sandbox**（执行环境） | workspace、进程、快照、恢复 | edit_file 工作区三级审批（Codex workspace-write 模型） | Sandbox 接口 + 本地适配器（M3） |
| **Observability**（观测面） | Trajectory、Evidence、回放 | sessions/*.jsonl（非类型化）、insights | 类型化 RunEvent + TrajectoryStore（M1，本 ADR 引入 @hmharness/observability） |

## 规则

1. **不推倒重写**：现有 public API（runAgentTask、Registry、CLI）保持兼容；
   新能力通过新包/新接口增量加入，调用方迁移后再删旧实现。
2. **事件优先**：关键行为先产生 Event（append-only JSONL），再由
   Evaluation/Evolution 消费；Event 写入失败永不阻塞 Run（best-effort）。
3. **密钥不进 Trajectory**：事件载荷只含工具名、参数摘要（截断）、
   结果状态与耗时；不记录环境变量与完整配置。
4. **执行与判定分离**（Evidence-first）：LLM 自评不得作为唯一成功依据；
   Judge 只读任务/Evidence/测试结果，不读执行 Agent 内部思维。
5. **进化必须有 baseline/promotion/rollback**：现有 canary A/B 门禁是
   唯一晋升通道；Evolution V2 候选（prompt/context/router）复用同一契约。
6. **kernel 保持零依赖**；observability 同样零依赖（纯 Node fs），
   任何新包不得把依赖倒灌进 kernel。

## 后果

- 新增 `@hmharness/observability`（M1）：RunEvent schema v1 + JSONL
  TrajectoryStore + `hmh replay`；每个 run 在 HMH_HOME/runs/<run-id>/ 留下
  trajectory.jsonl + summary.json。
- 现有 sessions/*.jsonl 保持不动（审计层）；runs/ 是结构化观测层，两者并存
  直至 sessions 的消费方（/resume、evidence）迁移到 Trajectory。
- 后续 ADR：0002 Event schema 版本化、0003 Trajectory 存储后端、
  0004 Capability 安全模型、0005 MCP 适配器边界（保持无状态核心）。
