# ADR-0008: Release 联动 + 状态备份覆盖 V2 资产（V3 Release 切片）

日期: 2026-09-13 · 状态: 已实施（0.12.0）

## 背景

V3 DoD 链的终点是 Release。M8 已有 Project Runtime（checkpoint/release 钉住），
0.10.0 有 pipeline（judge VERDICT 门）。两者未连接。同时发现 `hmh state backup`
的 STATE_ITEMS 停留在 0.6 时代：M8 projects/、M1 runs/（dataset 源头）、
pipelines/ 都不在备份集——一次 home 损坏就会丢掉 V2 全部新增证据资产。

## 决策

1. **Release 联动**：`runPipeline({ release })`（CLI `--release=<version>`）
   在 judge 最终 PASS 后自动执行 M8 动作：projectFor(ctx.cwd) → attachRun →
   checkpointProject(label=`pipeline <id>`) → releaseProject(version, notes)。
   FAIL/budget 不触发——**只有裁决通过的产物才配版本号**（蓝图红线：无证据
   不发布）。report 里记录 releaseTick（checkpointId/projectId/version）。
2. **备份覆盖**：STATE_ITEMS 追加 `projects`（决策日志+检查点引用，不可再生）
   与 `runs`（M1 轨迹 = dataset 源头 + readiness 证据，不可再生）；`pipelines`
   归入 --full（阶段报告可再生）。README 行为说明随 CHANGELOG。
3. 不做：Release 阶段的签名/上架自动化（属分发渠道集成，等真实发布渠道
   需求明确再做）。

## 后果

- `hmh pipeline "<task>" --release=v1.2.3` 一条命令走完五角色裁决→设备验证→
  项目检查点→版本记录。
- 回滚：纯增量。
