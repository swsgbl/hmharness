# 递归 Harness 自我改进研究对照（截至 2026-10-27）

## 使用范围与结论边界

本文用于决定 hmharness 下一轮实验，不是“AGI 已实现”的证明。Harness 优化与模型权重训练是两种不同的适应机制；更好的提示、工具策略、验证脚本、上下文调度或技能库，不应被表述为基础模型权重已变化。公开论文中的数字是作者报告的结果，必须在相同模型、任务集、依赖版本与预算下复现后，才能作为 HMH 自己的证据。

## 原始一手材料

| 方向 | 一手材料 | 可借鉴方法 | 对 HMH 的限制 / 注意 |
|---|---|---|---|
| HarnessPro | 论文 https://arxiv.org/abs/2610.26770；源码 https://github.com/pzs19/HarnessPro；项目页 https://pzs19.github.io/HarnessPro/ | 从执行轨迹诊断失败/冗余调用；候选 harness 采用合成测试评估；以 Lite/Medium/Heavy 维护性能—成本 Pareto 选择 | 不能直接复制其排行榜数字；合成测试可能被候选适配，必须留出官方 grader 与隐藏任务做独立终检 |
| Harness² | 论文 https://arxiv.org/abs/2610.14224；源码 https://github.com/google-research/harness2；基准说明 https://github.com/google-research/harness2/blob/main/docs/BENCHMARKS.md；实验 https://github.com/google-research/harness2/blob/main/docs/EXPERIMENTS.md | 当前任务内使用 Propose–Probe–Compose 做对照修订；任务结束后将证据提炼进持久的 improvement harness | 两层循环需要分别计量；同题探测不能冒充跨题泛化；审计时必须明确模型是否能访问网络、官方测试、参考答案与隐藏 grader |
| Recursive Agent Harnesses | 论文 https://arxiv.org/abs/2606.13643 | 把递归单位从单次模型调用扩展为完整 agent harness；复杂子任务用子代理并行，简单子任务用结构化调用 | 增加子代理会增加成本、状态冲突和安全边界，必须按任务难度分桶，并与相同预算 baseline 对照 |
| Recursive Harness Self-Improvement (RHI) | 论文 https://arxiv.org/abs/2607.15524 | 通过历史版本的 pairwise feedback 迭代优化 harness；强调信息流和上下文管理 | 公开结果覆盖的研究任务有限，应把其视为方法假设，而非普遍规律 |
| GEPA (Genetic-Pareto) | ICLR 2026 论文页面 https://proceedings.iclr.cc/paper_files/paper/2026/hash/0e9e708b6f48e14fd0ac29e167413f76-Abstract-Conference.html；源码 https://github.com/gepa-ai/gepa | 读完整轨迹再反思；定向变异；Pareto 保留互补候选；用少量 rollout 做可解释优化 | 候选对评测器过拟合仍是风险；必须分开探索/选择/最终测试的任务集 |
| Darwin Gödel Machine（实现参考） | https://github.com/lemoz/darwin-godel-machine | 代码级候选、隔离运行、候选种群与 held-out replay；保留失败/退化证据 | 第三方实现的结果不是原论文独立复现；代码自修改必须在沙箱/独立 worktree，不能自行修改安全门和评测器 |

## 建议给 HMH 的实现组合

不要把上述项目当作一个需要一次性复制的大平台。将它们拆成互相可消融的组件：

1. Trace diagnosis：从原始 trajectory、tool outputs、verification result 中定位错误类别，并保存完整 lineage。
2. Candidate generator：每轮最多生成少量、有明确假设的候选，变更范围只允许指令、工具策略、上下文策略、技能与可声明的工作流，不可改 evaluator/隐藏集/安全策略。
3. Contrastive probe：在相同任务、模型、预算下比较 Base / Candidate；把探测任务与最终留出任务隔离。
4. Pareto selection：至少报告成功率、每任务成本、延迟和安全回归，不要把全部压成单一奖励；为低成本/均衡/高能力需求保留候选档。
5. Continual experience：只提炼通过独立评测的 lesson；保留父版本、反例、适用前置条件和适用环境。
6. External acceptance：候选冻结后在不可写的外部评测上评估。若没有真实外部数据，明确标为 NEEDS-DATA。

## 一个最小复现任务，而不是更大的平台

首轮固定一个成熟 benchmark、一个模型/版本、一个执行后端、一个明确预算。建议先用 Terminal-Bench 2 或 SWE-bench Pro 的一小份、固定种子任务进行 smoke 与开发集试验；正式结果必须在未参与优化的官方测试分区上测量。对照包括：

- A0：仅基础模型 + 固定工具执行环境（可测时）；
- A1：当前冻结的 hmharness；
- A2：候选 harness；
- A3：A2 的保留/持续经验版本（下一批未见任务）。

所有臂使用相同的模型版本、任务提示、任务镜像、并发、超时、重试政策与 token / 成本上限。记录原始逐案例结果，禁止只发布均值。

## 原始资料与复现顺序

1. 先读论文正文、附录与开源的实际 runner/policy/config，不只读摘要或主页。
2. 锁定 Git commit、模型快照/Provider 配置、数据集版本与 hash、运行镜像 digest、随机种子和预算。
3. 先跑 baseline 与 evaluator 的阳性/阴性对照：已知应通过/必定失败的任务必须被 grader 分辨。
4. 再跑候选实验，输出每案例差异表与错误归因。
5. 最后跑冻结的 held-out；优化器不得读取测试详情或 grader。
6. 将报告、原始结果、机器可读 manifest 与复现命令一起归档。仓库历史归档的目录名不得替代真实生成时间和数据窗口。

## 关键参考

- HarnessPro (arXiv 2610.26770): https://arxiv.org/abs/2610.26770
- Harness² (arXiv 2610.14224): https://arxiv.org/abs/2610.14224
- Recursive Agent Harnesses (arXiv 2606.13643): https://arxiv.org/abs/2606.13643
- Recursive Harness Self-Improvement (arXiv 2607.15524): https://arxiv.org/abs/2607.15524
- GEPA, ICLR 2026: https://proceedings.iclr.cc/paper_files/paper/2026/hash/0e9e708b6f48e14fd0ac29e167413f76-Abstract-Conference.html
