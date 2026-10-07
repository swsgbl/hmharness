# Web 7788 事实地图（FACTMAP）

> 2026-10-07 周审计包（03 UI/UX 专项 + 04 MasterPrompt）强制第一步：先审计后改 UI。
> 本文是 IA/DOM/API/SSE/会话/右栏/输入区/定案约束的事实基线。任何 UX 改动先对照本文，
> 与 DESIGNS.md 定案冲突处必须先登记复案。

## 文件事实

| 文件 | 体量 | 角色 |
|---|---|---|
| `packages/web/src/page.ts` | 3672 行 / 212KB | 单页 UI：三栏工作台（左会话栏+中央对话+右栏 300-600px 拖拽 localStorage 记忆）；**per-session 渲染状态**（污染 bug 已修，全局单槽已废） |
| `packages/web/src/server.ts` | 104KB | 零依赖 http 服务：44 个 API 路由 + SSE `/api/events`（按 sessionId/seq 路由去重，断线重连）+ **每会话子进程 task-runner**（payload 文件+ndjson stdout+stdin 审批/注入/中止） |
| `packages/web/src/uilite.ts` | 15KB | 纯函数层：fuzzyMatchScore/parseUnifiedDiff/looksLikeDiff/extractPlan/extractDeliverables/renderMarkdown/zhTask |
| `packages/web/src/task-runner.ts` | — | W15：每会话子进程执行（真并行+cwd 隔离+崩溃隔离+detached 跑完+队列持久化重启恢复） |
| 测试 | 4 文件 | i18n-symmetry / server-utils / task-runner / uilite |

## API 面（44 路由，server.ts）

- **会话/任务**：`/api/sessions` `/api/task` `/api/interrupt` `/api/queue` `/api/inject`（W7 运行中注入）`/api/approve`
- **认知面板**：`/api/cognitive`（十区）`/drift` `/skills` `/trajectories` `/replay` `/transfer`（矩阵）`/team` `/calibration`（§26 校准）
- **工作区/文件**：`/api/workspaces`（+use/delete）`/api/fs`（+search/read，64KB+二进制嗅探）`/api/open`
- **配置/模型**：`/api/config` `/api/providers`（+delete）`/api/model` `/api/locale` `/api/ssh` `/api/devices`
- **远程/扩展**：`/api/qr` `/api/remote-info` `/api/pair-info` `/api/pair/rotate` `/api/tunnel/*` `/api/mobile/disconnect` `/api/extension/status`
- **其它**：`/api/state` `/api/events`(SSE) `/api/goal` `/api/command` `/api/feedback` `/api/label/*`

## page.ts 结构锚点（行号区段）

- 756-1000：per-session 渲染状态；会话路由与隔离（W4 三操作：重命名/归档/删除）
- 1070-1135：输入区三件套（W6 `/`+`@`+图片）+ W6/W7 运行中 Enter=排队 Ctrl+Enter=注入 + **busySessions 多会话运行点**
- 1190-1530：设置中心（W5）+ 认知面板区：校准报告/五环境学习曲线/goal drift 时间线/**transfer 矩阵**/轨迹回放（RD-010）
- 1997-2170：会话列表（重命名内联/归档/删除/导出/全文本搜索 A15/轨迹时间线 A13）
- 2381-2674：流式状态 per-view；工具 keyed 渲染（W9）；并行工具组；spawn_agent 卡（A7）；失败=人话（"failed" 不堆栈）
- 2246：右栏拖拽 300-600px（W8 详情/文件/预览三 tab）

## DESIGNS.md 生效定案（UX 改动的硬约束）

W1 工具流折叠/AI 回答主体 · W2 状态行输入框上方 · W3 审批三档 · W4 会话三操作 · W5 设置中心 · W6 输入三件套 · W7 运行中注入 · W8 右栏三 tab · W9 keyed 渲染 · W10 🎯+计划卡 · W11 权限预设卡 · W12 交付物 chips · W13 反馈+主题 · W14 轨迹时间线/搜索 · W15 每会话独立执行。**复案规则：推翻任一条必须先在 DESIGNS.md 复案记录登记。**

## 03 专项方案 → 现状差距（目标态）

| 专项要求 | 现状 | 差距性质 |
|---|---|---|
| 一级 IA 只留 Work/Observe/Build/Settings | 认知面板是会话内区段+侧栏多项 | IA 重组（复案 W-部分导航定案） |
| Turn 统一卡：Request→Plan→Actions→Verification→Answer | 工具流折叠行+计划卡+回答分立存在 | 整合既有件为单卡（W1/W10 兼容） |
| 运行八态 Ready→…→Recovering | busySessions 二态+状态行 | 状态机扩展（W2 增强，不推翻） |
| 右栏 Context Dock（Overview/Files/Diff/Evidence/Logs） | 三 tab 详情/文件/预览 | 扩两 tab（W8 增强） |
| Cognitive HUD（Goal/置信/预测/恢复/Evidence） | 认知面板区段已有数据源 | 顶部精简投影（新件，用 /api/cognitive） |
| Board 四栏 Mission | insights 卡片墙 | 重组织 |
| Environment 页（Devices/Browser/SSH 合一） | /api/devices+/api/ssh+/api/extension 分立 | 聚合页（新件） |

## 工程纪律（04 MasterPrompt）

零运行时依赖增量迭代（禁 React/Vue 类重型运行时，引入须 RFC）；长会话增量/批量渲染（禁每 token 全 DOM 重绘）；1000 会话/10000 消息 smoke；SSE 按 sessionId/seq 去重+断线恢复+切会话不串流；每次 UI 改动交 before/after 截图或 DOM 证据+回滚方案；无真实浏览器验证不得宣称完成。
