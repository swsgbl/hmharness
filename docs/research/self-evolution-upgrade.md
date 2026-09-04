# hmharness 自进化升级:全网验证后的差距分析与生产蓝图

> 依据:[Awesome-Self-Evolving-Agents](https://github.com/XMUDeepLIT/Awesome-Self-Evolving-Agents) 综述六维分类
> (Model-Centric Inference/Training;Environment-Centric Static/Dynamic/Modular/Topology;Co-Evolution)
> + 12 篇论文**原文逐篇验证**(2026-09-04;验证产物:arxiv 摘要+全文关键词检索,见文末)。
> 本文是初版蓝图的**验证修订版**:凡原转述与论文原文不符处,以原文为准修正。

---

## 第一部分:分类框架验证 + hmharness 现状定位

综述分类法与初版引用一致(六个方向标题与代表论文已逐条核对)。hmharness 现状:

| 综述维度 | hmharness 现状 | 评级 |
|---|---|---|
| 模型中心·推理时(自我纠错、验证器、采样) | 单轨迹单采样;Tier2 反思存在但仅事后入记忆,无 best-of-n、无计划验证 | ❌ |
| 模型中心·训练时(R-Zero/AZR 式) | 不涉及权重;进化对象=提示词/技能/记忆/代码(上下文即软权重) | ⚠️ 合理放弃 |
| 环境中心·静态知识进化(Agentic RAG) | 检索式记忆注入;无知识主动刷新 | ⚠️ |
| 环境中心·动态经验进化(GEPA/Voyager/AWM) | **核心资产**:三层反馈+技能三态+双门禁+holdout+防投毒+只增记忆+蒸馏;但单轨迹反思非种群 | ✅ 可升级 |
| 环境中心·模块化架构进化 | patches.ts(沙箱+bench 门+回滚)已起步;工具 schema 不可进化 | ⚠️ |
| 环境中心·拓扑进化 | spawn_agent 拓扑静态 | ❌ |
| 模型-环境协同进化 | 无 | ❌(暂缓) |

结论不变:骨架正确,缺**推理时进化、种群式经验进化、(架构进化已起步)**。

---

## 第二部分:教训验证结果(**初版三处失真,一处反转**)

### 修正 1:GEPA 机制(原文与初版描述不符)

- ✅ 成立:种群式(Genetic-Pareto)、Pareto 前沿多样性采样、变异+Merge 交叉、ancestry 记录。
- ❌ 失真:"每轮 k 个候选并行采样→选优"不是 GEPA 机制。原文 Algorithm 1:每轮从
  Pareto 前沿**随机采样一个祖先**,反思生成**一个**变体,minibatch 评估,优于父代才入池。
- **修正后采纳**:候选池+Pareto 前沿+单祖先变异稳态循环(而非 k-候选锦标赛);
  评估器打分保留(hmharness 自有增强,按"自创增强"标注,不冒充论文机制)。

### 修正 2:DGM 失败模式(术语错误)

- ❌ 初版:"DGM 的死因是漂移"。原文 v1/v3 全文 "drift" **0 命中**。
- ✅ 真实失败模式:**objective hacking**(node 114 绕过幻觉检测函数骗取高分;论文明确
  类比 reward hacking + Goodhart 定律)。
- **修正后采纳**:hmharness 已有的防投毒屏 + **对进化产物隐藏评估细节** +
  **金丝雀对照**(objective hacking 的直接解法:不只看被优化指标,看对照组)。

### 修正 3:ACE "bench 门控版本化"(论文并无此机制)

- ❌ 初版:"ACE 用 bench 门控版本化上下文"。原文无 version/rollback/holdout;
  真实机制=embedding 去重 + **上下文长度触发**的修剪。
- ✅ 成立:上下文=进化对象(evolving playbooks);增量更新防 context collapse。
- **修正后采纳**:hmharness 若做"提示词版本化+bench 门控",是**自创增强**(合理,
  但不冒充 ACE);ACE 真正教我们的是:记忆/技能**增量条目化**更新,永不整体重写
  ——hmharness 记忆只增不删原则与此吻合,继续保持。

### 反转:Voyager 技能库膨胀

- ❌ 初版:"论文自己承认膨胀问题"。实际**论文把 ever-growing 当卖点**,
  全文无任何 merge/delete/decay 机制。
- ✅ 真教训(更硬):膨胀问题真实存在但**被论文忽视**——hmharness 做生命周期算子
  (merge/decay/pin)是**超出论文的补课**,不是复现。

### 成立的教训(原文直接支持)

| 教训 | 来源 | 采纳 |
|---|---|---|
| 被优化指标必须对进化系统隐藏/加固,否则必被 hack | DGM objective hacking + Misevolve reward hacking | P0 金丝雀对照 + 评估细节不进提示词 |
| 多样性保持(Pareto/档案)防局部最优 | GEPA + DGM 共同支柱 | P1 候选池 |
| 反馈质量是反思系统瓶颈:94% 失败源于反馈错误定位/修法 | Self-Refine 原文定量 | Tier2 反思提示词要求"先定位再开方" |
| 信号放大为结构化语言经验才有迁移力 | Reflexion | 已吻合(lesson/self-note 格式) |
| 经验要抽象到策略级,失败经验不可浪费 | ReasoningBank | P1 蒸馏提示词分层 |
| 分层检索:规划期工作流级+执行期纠错级 | Agent KB | 技能描述字段已有;维持 |
| 注入知识有干扰风险,需分歧门控 | Agent KB disagreement gate | 金丝雀期"实验品水印" |
| 外部可验证锚点 > 纯自评 | AZR 执行器 / R-Zero 不确定度 | 双样本 bench 门已吻合 |
| 自进化无护栏会失稳 | AZR "Safety alarms ringing" | 预算闸门+红线不动 |

### Misevolve 四路径(原文确认)

memory 进化→**safety alignment decay + 部署期 reward hacking**(拒答率降 45%,ASR 0.6%→20.6%,顶级模型同样中招);tool 进化→后门/漏洞;统一假说=**过度依赖过往经验而缺乏批判性反思**。
→ hmharness 对策:防投毒屏已有;**新增**:进化产物注入时带"references not rules"框架
(Misevolve 论文自己的缓解:"把记忆当参考资料而非规则"救回一半)+ 批判性反思并入 Tier2 提示词。

---

## 第三部分:修正版蓝图(执行版)

### P0 可观测与金丝雀(先于一切算法)

1. **血缘账本**(evolve.ts):EvolveReport 每条 outcome 记 `lineage`:
   {parentInsights: 洞察 ID, scores: {train, holdout}, metaModel, promotedAt};
   会话 Insight 增 `skillsInjected: string[]` —— 影响面可算(哪些技能进过哪些会话)。
2. **结果归因闭环**(insights.ts + runner.ts):Insight.outcome 扩展人工信号;
   `hmh bench --impact`:按"晋升时间点前后 N 会话成功率"分组对比,输出
   promoted-skills × before/after 表(数据不够时诚实输出 insufficient data)。
3. **金丝雀晋升**(skills.ts):新态 `canary`;注入管线按 20% 会话采样混入;
   转正条件:对照组(无该技能会话)与实验组(有)各 ≥8 个会话且实验组成功率
   ≥ 对照组+10%,或实验组 30 会话零回归 → auto promote;否则 30 天到期回滚。
   **canary 注入时系统提示词声明"实验技能,references not rules"**(Misevolve 缓解)。
4. **进化预算闸门**(kernel types + evolve.ts):config `evolutionBudget`:
   {maxTokensPerCycle, maxCyclesPerDay};runEvolution 入口检查当日 log 计数,
   超限即 skip 并记 budget-skip。

### P1 经验进化种群化(忠实 GEPA 机制 + 自创增强标注)

5. **候选池+Pareto 前沿**(evolve.ts):每次进化产出的技能(含被拒者)入池
   `evolution/pareto/`,记录 (name, scores, rejectedReason);**每轮从池中随机
   采一个祖先**喂 proposeSkills 提示词("参考此既有技能的角度,提出一个变异改进");
   首轮池空=现状。评估器打分(bench 相关性/具体性/可验证性三轴)为 hmharness
   自创增强(标注[enh],非 GEPA 原文),用于拒绝明显劣化候选、省 bench 成本。
6. **Merge 交叉算子**:当池中两个被拒候选拒因互补,提示词要求合并两者角度。
7. **技能生命周期算子**(skills.ts):
   - `merge(a,b)`:检索发现高重叠(同主题+描述 cosine 粗相似)→ 蒸馏合并,原归档;
   - `decay`:30 天零注入降权出注入集(不删,移 skills/dormant/——只增不删红线);
   - `pin`:`hmh skills pin <name>` 用户钉住永不被进化动。
8. **AWM 工作流归纳**(新 workflows.ts):洞察聚类(同任务前缀 ≥3 次)→
   元模型归纳参数化工作流模板(带 {{参数}} 占位)→ 走既有 draft→gate 管线
   (与普通技能同门禁,不另开口子)。

### P2 推理时进化(下轮)

9. 高代价操作前计划验证(n=3 采样+规则验证器)——Self-Refine 教训:验证器
   要校验"修法对不对"而非"改没改"(61% 失败是修法错)。
10. Tier1 第 2 次失败插 CRITIC 结构化反思(Reflexion 信号放大),第 3 次短路不变。
11. 静态知识刷新(knowledge.ts):鸿蒙官方文档快照 diff→知识补丁技能草案→过门。

### P3 拓扑(可后置)
spawn_agent 角色成功率记录+锦标赛淘汰(诚实最小版)。

### 红线(全部轮次不变)
- 进化写域仍限 skills/+memory/(+已批补丁通道);kernel loop/provider/config/security 永不可触;
- 评估细节(bench 用例/expect)永不出现在进化元模型可见的提示词里(objective hacking 防线);
- canary 产物全程带实验水印;进化独立进程已满足;预算闸门防失控。

---

## 验证产物索引

- 综述原文:本仓 .research-repo.md(拉取自 GitHub main,57KB)
- 论文验证脚本与全文快照:C:/Windows/Temp/{gepa,dgm,misevolve,awm,ace}_api.xml、
  *_full.html、dgm_v1.html、verify_search*.py;Voyager/R-Zero/AZR/Self-Refine/
  Reflexion/Agent-KB/ReasoningBank 同批完成(代理 curl --ssl-no-revoke + ar5iv 交叉)。
- 关键论文:GEPA 2507.19457 · DGM 2505.22954 · Misevolve 2509.26354 · AWM 2409.07429 ·
  ACE 2510.04618 · Voyager 2305.16291 · R-Zero 2508.05004 · AZR 2505.03335 ·
  Self-Refine 2303.17651 · Reflexion 2303.11366 · Agent-KB 2507.06229 · ReasoningBank 2509.25140
