# Codex / DeepSeek → hmharness 智能体工程升级方案

## 对比结论（三方数据已核实）

| 维度 | Codex (开源 Rust) | DeepSeek (系统提示词) | hmharness (现状) | 升级优先级 |
|------|---|---|---|---|
| 规划机制 | `update_plan` 工具，多步进度追踪 | Search-then-plan 显式分段 | **无**——全靠模型隐式推理 | **P0** |
| 持久执行 | "Persist until fully handled end-to-end" | 有 think 工具，逐步推进 | 无指令——模型容易中途停 | **P0** |
| 编辑工具 | `apply_patch` 搜索替换 | 无（重写文件） | 只有 `write_file` 全量覆盖 | **P0** |
| 并行工具 | 支持但不在提示词里要求 | 无 | 支持（Promise.all），不在提示词里说 | **P1** |
| 项目知识 | AGENTS.md 层级发现 | 无 | 无 | **P1** |
| 代码纪律 | "不要修改不相关的变更" | "读文件前先检查路径存在" | 有 `read before write` 一句 | **P1** |
| 审批持久化 | 动态 approval → 写入 .rules | 无 | 无 | **P2** |
| 质疑指令 | "review=代码审查模式" | "要合理质疑" | 无 | **P1** |
| 输出规范 | 详细格式规范（分规模） | 无 | 无 | **P2** |
| 终止条件 | 明确区分完成/继续 | 无 | 无（靠 maxTurns 硬停） | **P1** |

## 升级计划（9 项，按文件分三批实现）

### 第一批：系统提示词升级（prompt.ts）+ 新工具（tools.ts）

**改动 1：prompt.ts 全面重写系统提示词**

采纳 Codex 的五个核心指令 + DeepSeek 的三项，写入系统提示词：

```
新增/改写的段落：

1. [Codex] 持久执行指令：
   "Persist until the task is fully handled end-to-end within the current
   turn: do not stop at analysis or partial fixes; carry changes through
   implementation, verification, and a clear explanation. Only stop when
   the user explicitly pauses or redirects."

2. [Codex] 规划协议（内联，不依赖工具）：
   "For non-trivial tasks: (1) outline your approach in 2-4 steps before
   acting; (2) after completing each step, confirm it succeeded before
   moving to the next; (3) if verification fails, diagnose and retry -
   don't skip forward. Skip planning for trivial one-liners."

3. [Codex] 并行优先：
   "When multiple independent tool calls are needed (e.g. fetch several
   files, check multiple paths), invoke them in the same turn rather than
   one by one. The framework executes independent calls concurrently."

4. [Codex] Git 工作区纪律：
   "You may be in a dirty git worktree. NEVER revert existing changes you
   did not make. If you notice unexpected changes, STOP and ask the user."

5. [Codex] 代码审查模式：
   "When asked for a 'review', default to code review mindset: prioritize
   identifying bugs, risks, regressions, missing tests. Findings first,
   ordered by severity with file:line references."

6. [DeepSeek] 显式分段执行：
   "对于需要推理和执行多步骤的任务，分步进行：先搜索信息并列出要点，
   再规划步骤，最后才执行。不要跳过规划直接操作。" (英文版本同步)

7. [DeepSeek] 合理质疑：
   "如果用户要求的方案存在风险或替代方案，你应该主动提出，并说明
   利弊，帮助用户做出选择。只执行确认过的方案。"

8. [Codex/DeepSeek] 代码编辑纪律（配合新 edit_file 工具）：
   "Prefer edit_file for surgical changes (search-replace). Only use
   write_file for new files or complete rewrites. Never overwrite a file
   you haven't read. Never amend a commit unless asked. If changes appear
   in files you haven't touched, stop and ask."

9. [新增] AGENTS.md 发现（与 Cangjie 用例结合）：
   "If a file named AGENTS.md or CLAUDE.md or .cursorrules exists in the
   current directory or any parent up to the workspace root, read it -
   it contains project-specific instructions from the user that override
   general guidelines. Deeper files take precedence."
```

保留现有段落（Host environment、Cross-framework skills、HarmonyOS domain、Working style），不删已有内容。

**改动 2：tools.ts 新增 `edit_file` 工具（Codex apply_patch 模式）**

这是 Codex 最有价值的设计之一——搜索替换替代全量覆盖：
- 参数：`{ path, old_string, new_string }`（与 ZCode/Edit 工具同一接口）
- 不 needsApproval（比 write_file 安全得多——只改声明的片段）
- old_string 必须在文件中唯一，否则报错
- 失败时给清晰错误（没找到/不唯一），模型可自行修正
- 同时在 prompt 里引导优先使用 edit_file

**改动 3：tools.ts 增加 AGENTS.md 发现工具或自动注入**

实现方式：在 contextPack 里检查 cwd 及向上到工作区根目录是否有 AGENTS.md/CLAUDE.md/.cursorrules，有则自动注入系统提示词（在 memory 之后）。不注册为工具——它是被动发现，不需要模型主动调用。

### 第二批：循环增强（loop.ts / runner.ts）

**改动 4：loop.ts 滚动预算（防止无限循环的非截断式收口）**

采纳 Codex 的 `token_budget_context` 思想：
- 当剩余预算 < 20% 时，注入一条系统消息："Context budget running low. Wrap up the current task, summarize what was accomplished, and suggest next steps. Do not start new sub-tasks."
- 不是强制截断，而是给模型一个收口信号——比 maxTurns 硬停更智能

**改动 5：runner.ts 审批持久化（采纳 Codex 的 .rules 模式）**

用户批准过一次的命令模式（如 `hdc shell`），写入 `HMH_HOME/approved-rules.json`，后续同类命令自动批准。实现：
- makeApproval 里，先查规则（按命令前缀匹配），命中直接放行
- 规则格式：`{ prefix: "hdc shell", approved: true, time: ... }`
- 规则在 config.json 旁，用户可手动编辑
- 硬拒绝列表（DENY_PATTERNS）永远覆盖规则

### 第三批：提示词层补全（i18n.ts）

**改动 6：i18n 补充 Codex 发现的两个空键**

1. `cmdResuming` — TUI 加载 /resume 时的提示（已有实现，补 i18n 键）
2. `cmdEvolveHint` — /evolve 帮助文本（已存在于命令块但无独立键）

### 测试策略

- edit_file 测试：唯一匹配成功 / 不唯一报错 / 文件不存在 / 替换后内容正确
- AGENTS.md 发现测试：有 AGENTS.md → 注入 / 无 → 不注入 / 深层覆盖
- 审批持久化测试：批准 hdc shell → 写入规则 → 同类命令自动放行 / 危险命令仍拦截
- 预算收口测试：模拟剩余 15% 预算 → 检查注入收口消息
- prompt.ts 本身的内容门禁：关键词存在性断言（Persist、edit_file、parallel、AGENTS.md）

### 验证链

node --import tsx --test → 全套（现有 115 + 新增 ~15 ≈ 130）→ npm run build → 提交推送

### 文件清单

| 文件 | 改动性质 |
|---|---|
| `packages/agent/src/prompt.ts` | 重写（新增 ~30 行系统提示词） |
| `packages/agent/src/tools.ts` | 新增 edit_file 工具 + AGENTS.md 发现 |
| `packages/agent/src/runner.ts` | 预算收口注入 + AGENTS.md 注入 contextPack |
| `packages/kernel/src/loop.ts` | 剩余预算 < 20% 收口消息注入 |
| `packages/kernel/src/context.ts` | 导出 budgetPercent 供 loop 使用 |
| `packages/agent/src/i18n.ts` | 补空键 |
| `packages/agent/src/__tests__/prompt.test.ts` | 新建：系统提示词内容门禁 |
| `packages/kernel/src/__tests__/loop.test.ts` | 新增预算收口测试 |
| `packages/agent/src/__tests__/tools.test.ts` | 新增 edit_file + AGENTS.md 测试 |