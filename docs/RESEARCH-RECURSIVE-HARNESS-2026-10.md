# Recursive Harness Self-Improvement：一手研究对照（2026-10-27）

## 研究边界
Harness 迭代优化的是模型周围的指令、工具、执行策略、上下文/观察管理、技能与工作流；除非实际训练模型权重并验证，否则不得将 harness 改善描述为基础模型权重变化。论文的作者报告数字不是 HMH 的结果，只有在相同模型、任务、预算和 grader 下复现后才可作为本项目证据。

## 原始论文与仓库

| 工作 | 原始材料 | 对 HMH 的可借鉴点 | 不能直接推出的结论 |
|---|---|---|---|
| HarnessPro | https://arxiv.org/abs/2610.26770 · https://github.com/pzs19/HarnessPro · https://pzs19.github.io/HarnessPro/ | 轨迹诊断、候选 harness、LLM 生成测试、性能—成本 Pareto（Lite/Medium/Heavy） | 作者报告的 +2.0pp / -26.1% 不是 HMH 的实测收益；隐藏 grader 和最终 holdout 仍需独立。 |
| Harness² | https://arxiv.org/abs/2610.14224 · https://github.com/google-research/harness2 | 任务级 Propose–Probe–Compose 对照修改，加上跨任务累积有证据支持的 lesson | 单任务内有用不等于未来任务迁移；官方实验提示网络/公开 rubric 可能污染评测，应实施出口网络限制。 |
| ModularRSI | https://arxiv.org/abs/2609.14857 · 社区实现参考 https://github.com/IQuestLab/ModularRSI（不能确认是作者官方仓库） | 同任务成功/失败轨迹对比，跨任务归纳共性缺陷；把 Agent Loop、Tool Use、Observation Management、Context Management、Task Completion Detection 分模块独立演进 | 作者报告的 benchmark-disjoint 结果仍须按原实验复现；社区实现不能冒充官方实现，许可也需独立核对。 |
| Recursive Agent Harnesses | https://arxiv.org/abs/2606.13643 | 把递归单位从单次模型调用扩展为完整 agent harness；按子任务粒度选择子代理或结构化调用 | 199 个 Oolong-Synthetic 样本上的结果不代表跨领域普适；必须同预算评估子代理开销。 |
| Recursive Harness Self-Improvement (RHI) | https://arxiv.org/abs/2607.15524 | 利用修改历史的 pairwise feedback 迭代优化文本化 Agent loop，强调上下文/代理间信息流 | 30 个合成研究任务的收益是有限任务分布的作者报告，不可当作 HMH 的泛化证明。 |
| GEPA | https://proceedings.iclr.cc/paper_files/paper/2026/hash/0e9e708b6f48e14fd0ac29e167413f76-Abstract-Conference.html · https://github.com/gepa-ai/gepa | 对完整轨迹做可解释反思、定向变异、Pareto 保留互补候选 | 反思可以过拟合 grader；必须隔离 dev / selection / held-out。 |
| Darwin Gödel Machine（实现参考） | https://github.com/lemoz/darwin-godel-machine | 代码候选、隔离执行、种群和 held-out replay | 第三方实现并非原论文的独立验证；不可允许修改者写安全门、密钥或评测器。 |

## 建议 HMH 实施顺序

1. 限定修改范围：先按模块限制候选权限；安全/沙箱、evaluator、隐藏任务、发布凭证不可进化。
2. 跨任务失败诊断：收集多条成功与失败轨迹，识别反复出现的系统缺陷，避免单条轨迹把任务答案写进全局策略。
3. 有限候选 + 对照探测：每次只提出少量具备明确 hypothesis 的变更，用同任务/同模型/同预算的对照验证。
4. 能力—成本 Pareto：至少报告 success、cost、latency、tool calls、recovery 与 safety，不压成一个会遮蔽代价的总分。
5. 持续经验晋升：只有通过独立 gate 的 lesson 才能跨任务复用；记录适用前置条件、反例、父 lineage 和回滚原因。
6. benchmark-disjoint 复现：进化任务与下游最终 benchmark 按来源和任务族隔离；冻结候选后才打开 hidden/official grader。
7. 外部重放：锁定 commit、依赖、模型/provider、运行镜像、网络策略、任务集 hash、seed 和资源预算；公开逐案例结果。

## 最小可证伪实验
- A0：最小固定 harness（仅当 benchmark 可比）。
- A1：冻结版 HMH。
- A2：只改变一个候选模块的 HMH。
- A3：将通过 gate 的 lesson 用在之后未见任务。
- Primary metric：独立 grader 的 task success / accepted completion，预先声明最小有意义效应。
- 约束：成本、延迟、恢复数、安全回归；Brier/ECE 作为校准辅助指标而非任务能力替代品。
- 统计：二元配对任务报告 win/loss/tie，McNemar exact 和 95% 区间；连续指标采用按任务/项目聚类 bootstrap。
- 失败条件：hidden 泄漏、模型/预算不等价、grader 阳性/阴性控制失效、安全回归，均使实验无效或拒绝晋升。

## 复现材料
先读论文正文和附录，再固定仓库 commit、runner/policy/config、数据集 revision、容器 digest 和网络出口限制。保留原始 JSONL、manifest、错误日志、候选 diff 和测试命令。小样本/缺失分母标记 NEEDS-DATA，无任务净增益写 NO-LIFT；不降低阈值，不把未知值填零。
