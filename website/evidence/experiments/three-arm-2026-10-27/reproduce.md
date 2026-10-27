# 复现指南

前置:本机 `~/.hmharness` 已有 bench 语料(115 .task)与 `providers.glm`(zhipu coding plan)配置;Node ≥ 22;仓库在本分支(`research/three-arm-main-experiment-2026-10-27`)。

```bash
npm install
npx tsx scripts/three-arm-experiment.mts setup    # 冻结 manifest(任务集+datasetHash+快照+protect 只读副本)
npx tsx scripts/three-arm-experiment.mts phase0   # null control:A × 55 题 × 3 seeds(~165 runs)
npx tsx scripts/three-arm-experiment.mts phase1   # 候选生成(冻结 meta-model)
npx tsx scripts/three-arm-experiment.mts phase2   # 真实 evolution 门控
npx tsx scripts/three-arm-experiment.mts phase3   # 三臂主实验(~495 runs)
npx tsx scripts/three-arm-analyze.mts             # 统计判定 → analysis.json + report.md
node --import tsx --test packages/evolution/src/__tests__/three-arm.test.ts   # 判定器 15 用例
```

- 每个 phase 支持断点续跑(已完成 `(arm,seed,taskId)` 自动跳过)。
- 复现一致性:`setup` 输出的 `datasetHash` / `manifestSha256` / `protectFingerprint` 应与本目录 `manifest.json` 及 `analysis.json.datasetHash` 一致;任务选择、洗牌、bootstrap 全部 seeded,除模型采样(服务端默认,非确定性来源已在 null 波动中量化)。
- 产物:`phases/0-null.jsonl`、`phases/1-candidate.json`、`phases/2-gate.json`、`phases/3-main.jsonl`(每 run 一行,schema 见 design.md)、`phases/{0,3}-outputs/`(逐 run 原始输出全文)、`analysis.json`、`report.md`。
