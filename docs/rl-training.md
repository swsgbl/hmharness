# RL 训练数据集使用指南（DPO）

hmharness 的 RL 管线到此为止产出的,是一份**可直接喂给外部 DPO 训练器**的数据集;本文说明格式、来源语义与接入方式。

## 数据集在哪里

- 路径:`~/.hmharness/evolution/dpo-pairs.jsonl`
- 清单:`~/.hmharness/evolution/dpo-manifest.json`(版本号、来源分布、切分规模、审计四项)
- 重新生成:`hmh reward export-dpo`(自动去重、按任务分组 8:2 切分、审计,审计非零会黄字警告)

## 每行格式

```json
{"prompt":"任务原文","chosen":"被偏好的回答","rejected":"被拒绝的回答",
 "chosenSession":"...","rejectedSession":"...","gap":0.4,
 "source":"judge|human|mixed","split":"train|eval"}
```

- `source`:该对的偏好来源。**judge**=评审智能体(agnes,与执行模型 glm 异族);**human**=仅人标(注意:2026-09-21 定性为盲目打分,只作历史);**mixed**=一侧人标一侧评审。
- `split`:按 **prompt 哈希**分组切分(同一任务的所有对必在同侧,防评估泄漏),确定性 FNV-1a,不随重跑洗牌。

## 偏好信号的质量保障

- 评审量规:完成度/诚实性/效率/安全,1-5 锚定打分,STRICT JSON 输出,解析失败即丢弃该条(绝不编造分数);
- 健全性检查:`hmh judge` 每批后输出 ok 桶 vs 降级桶均分(当前 3.8 vs 2.64,分离清晰);
- 审计四项(空 prompt/空回答/重复对/泄漏)全零才可训练;
- 溯源:评审标签存 `evolution/judge-labels.jsonl`(带评审模型与时间),人标原文件不动。

## 接入训练器(任选)

数据即标准 `{prompt, chosen, rejected}` 三元组,主流 DPO 训练器都直接吃:

- **LLaMA-Factory**:`dataset_info.json` 里加 `{"hmh_dpo": {"file_name": "dpo-pairs.jsonl", "ranking": true, "columns": {"prompt": "prompt", "chosen": "chosen", "rejected": "rejected"}}}`,只取 `split=="train"` 行做训练集、`eval` 行做评估集;
- **ms-swift / axolotl**:同样按 preference 三元组导入;
- 自写循环:遍历 jsonl,对 `chosen`/`rejected` 各算 logprob,代入 DPO 损失即可。

先小规模(如 500 对)跑通链路,确认 loss 下降与 eval 侧 chosen-logprob 上升,再放量。

## 持续积累

- `hmh judge [N]`:评审下一批未标注会话(降级优先;`--rehuman` 连人标会话一并重判);
- 标签涨了以后:`hmh reward fit`(奖励模型,评审优先基准)→ `hmh reward export-dpo`。
