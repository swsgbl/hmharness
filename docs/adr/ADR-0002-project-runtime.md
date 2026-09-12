# ADR-0002: Project Runtime（V2 M8）

日期: 2026-09-13 · 状态: 已实施（0.8.4）

## 背景

V2 蓝图 M8 要求 Project 实体：projectId/workspace/state/checkpoints/tasks/decisions/
memory/skills/runs/benchmarks/releases，生命周期 created→active→paused→resumable→
completed→archived，必实现 Checkpoint/Resume/Interrupt/Recovery/Rollback/
Artifact versioning/Run continuation。此前这些能力分散在 sandbox（隔离快照）、
kernel session（0.8.2 起 rollout append）、evolution（记忆/技能），没有项目级聚合。

## 决策

1. **落点 packages/agent/src/project.ts**（agent 已依赖 kernel+evolution，新增
   @hmharness/sandbox 依赖）。Project Runtime 是编排层，不新建包——发布面已 11 包。
2. **Checkpoint = git plumbing 快照，零用户树接触**：临时索引
   （GIT_INDEX_FILE 指向 projects 目录下的临时文件）+ `read-tree HEAD` + `add -A`
   + `write-tree`。对象落入工作区 .git/objects（可被 gc），**绝不**动用户的
   索引/引用/工作树/分支。非 git 工作区降级为目录拷贝（跳过 .git/node_modules/
   dist）。存的是 tree sha——字节级、可 diff、可物化。
3. **Restore/Recovery = 物化到沙箱副本**：`git archive <tree>` + tar 解到新
   sandbox 会话目录。**永不**把 reset --hard 类操作打回用户工作区——恢复是
   供检视/续跑的副本，不是对用户树的破坏性回滚。
4. **Run continuation 复用 0.8.2 rollout append**：`attachRun` 记录 sessionId，
   resume bundle = lastRun + lastCheckpoint，调用方 loadTranscript 后以
   `sessionId` 续写同一 rollout。
5. **Interrupt 语义**：记录 interrupt 决策并置 paused（resumable）；实际中止
   仍由调用方 AbortSignal 负责（kernel 已有）。
6. **决策日志**：全部关键动作 append 进 project.json 的 decisions 数组 +
   decisions.jsonl 镜像（蓝图"关键决策写入 Project Memory"）。
7. 生命周期转换白名单校验，非法转换直接抛错。

## 后果

- 用户工作区可随时打检查点而无需 commit（快照对象对用户 git 不可见、无副作用）。
- 危险性操作（restore）只产生副本，M8 阶段无任何路径能破坏用户工作区。
- CLI 暴露 `hmh project status|checkpoint|restore|pause|resume|complete|archive|release`。
- 回滚方案：新模块纯增量，删除 project.ts + CLI 分支即回到 0.8.3 行为。
