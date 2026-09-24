# hmharness 架构清单（M0 基线冻结 · 2026-09-12）

> V2 施工的"现有资产盘点"。每项标注与 V2 蓝图（M0–M12）的对应关系，
> 避免重复造已有的东西。基线 tag：`v2-foundation-baseline`（0.6.8）。

## 包与入口

| 包 | 职责 | V2 蓝图对应 |
|---|---|---|
| @hmharness/kernel | loop/provider/registry/session/config/mcp/shellgate/window/context，零依赖 | Runtime 核心（保持） |
| @hmharness/evolution | insights、skills 五态、bench 双门禁+holdout、canary A/B、patches(autoPatch 默认关) | Evolution V2 的 skill 分支已就绪；M9 需泛化 candidate 类型 |
| @hmharness/domain-harmony | 脚手架/构建/签名/装机/设备测试/UI 回归/emulator/apikg | domain-harmony Adapter 化（M13 蓝图）起点 |
| @hmharness/domain-ops | 雷达（90 天新鲜度哨兵）、issues、channel | Domain 扩展 |
| @hmharness/agent | runner、prompt（身份末尾锚定+trivial 降级）、tools×14、spawn | Orchestrator 雏形（spawn=Agent Team 种子） |
| @hmharness/web | 7788 本地服务器（DNS-rebinding 守卫）、三态发送/停止、队列栏 | Web UI 施工顺序第 0 项（聊天）；Replay/Timeline 属 M1+ |
| @hmharness/cli | REPL/TUI/Web 守护/MCP server/bench/evolve/state | CLI 命令族 |

## 已存在的 V2 原语（蓝图里被低估的部分）

| V2 蓝图概念 | 现状 |
|---|---|
| Skills V2 五态生命周期 | **已有**：draft→canary→active→dormant→archived（skills.ts+impact.ts） |
| Control/Treatment 实验 | **部分已有**：canary 暴露组 vs 对照组（≥8 会话 ≥10% 差）、双样本门禁、holdout、Pareto 档案 |
| Deny-first + Capability Policy | **部分已有**：DENY_PATTERNS、needsApproval(args,ctx)、shellgate 零元字符裸探测、edit_file 工作区三级审批 |
| Trajectory | **雏形**：sessions/*.jsonl（user/assistant/tool/approval 事件，非类型化）→ M1 升级 |
| Evaluation | **雏形**：bench/*.task（exact/regex/none/any 断言）+ evidence 页 → M2 泛化 Evaluator 接口 |
| Agent Team | **种子**：spawn_agent（深度 2、共享审批、审计前缀）→ M7 角色化 |
| Sandbox | **部分已有**：审批层级=权限面；快照/恢复缺 → M3 |
| Project Runtime | **部分已有**：hmh state backup/restore + 工作区切换 + 会话恢复 → M8 checkpoint 化 |

## 真实缺口（按蓝图 P0 排序）

1. **M1 Trajectory**：类型化 RunEvent + TrajectoryStore + replay ← 本次施工
2. M2 Evaluator/Judge 接口（Evidence 优先级链）
3. M3 Sandbox（snapshot/restore/diff）
4. M4 Capability Manifest/Registry/PolicyEngine
5. M6 HarmonyBench 规模化（3 → 50 tasks）
6. ACP client（Zed 协议，P2）

## CI 基线（M0 验收）

- PR/CI：typecheck ✓ unit(155+2) ✓ build ✓ preflight ✓ website guard ✓
- 发布链：preflight 内含 typecheck+unit（0.6.7 起），八包有序发布
- 安全基线：shellgate 测试 14 载荷、DNS-rebinding 全路由、审计日志先落盘再可见（0.6.8）
