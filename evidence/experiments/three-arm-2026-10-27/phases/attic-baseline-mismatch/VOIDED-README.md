# 作废说明(append-only 纪律:不删除,只归档)

2026-10-27 phase0 首轮跑到 49/165 时发现:驱动脚本 `loadSnapshot` 的 description
提取正则与 `packages/evolution/src/skills.ts#parseDescription` 不一致(34 个快照
skill 中 5 个提取出不同描述:`## When to use` 标题行 vs 正文首行)。后果:若继续,
evolution 门控的 baseline 注入(listSkills→skillsToPrompt)与主实验 A 臂注入
(loadSnapshot→snapshotToPrompt)不是同一字节序列——"三臂之间只允许目标改动不同"
被破坏。

处置:作废本轮全部 phase0 记录(0-null.jsonl / predictions.jsonl / 0-outputs/),
修复提取逻辑为与 skills.ts 字节级一致(见 scripts/three-arm-experiment.mts
`parseDescriptionLikeSkillsTs` 注释),phase0 从零重跑。

- 作废时间:2026-10-27 18:20 前后(49 条 A 臂记录,无 B/C 数据,B/C 从未开始)
- 作废记录在此目录:`0-null.jsonl`(49 行)、`predictions.jsonl`、`0-outputs/`
- 预注册(manifest.json)未变;datasetHash 不受影响(任务集未动)
