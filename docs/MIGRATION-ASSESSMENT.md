# 旧线 harmony-harness → hmharness 能力迁移评估

评估日期:2026-08-27。盘点对象:`C:\Users\hongfu\harmony-harness`(v0.2.1,pnpm workspace,基于 DeepSeek Harness)。
方法:全量扫描七包 package.json/src 入口/工具定义/skills/docs(34 工具逐一定位)。
原则(ROADMAP):**不迁移代码,迁移知识与验证过的事实**。

## 总览:34 工具/6 实包 → 逐项判定

| 旧线包(工具数) | 职责 | 判定 | 依据/去向 |
|---|---|---|---|
| harmony-scaffold(3) | 工程脚手架/构建 HAP/运行 | **已被超越,不迁移** | 新线 harmony_project_create/build/install/launch 已真机全回路验证;旧线模板树更全(多模板选型),值得抄清单,见下 |
| harmony-tools(6) | cjpm 仓颉构建测试/看图/hdc/hilog | **部分迁移** | hdc 设备/hilog 已有且更强(审批门禁);**缺口:cjpm(仓颉)构建/测试、see_image(图像查看)** → 新线 backlog |
| harmony-quality(4) | 项目画像/codelinter/视觉回归/质量报告 | **延后迁移(需依赖论证)** | codelinter 包装价值高但引外部依赖,过红线评审再做;pixelmatch 视觉回归同理;画像思路并入 bench 用例设计 |
| harmony-evolution(9) | 记忆/技能草稿/晋升/bench/evo-git | **已被超越,不迁移** | 新线 evolution 四件套+三态管线+holdout 门禁+进化日志已落地且更严(自动 A/B+保留集);旧线"人工批准晋升"已被新线门禁自动化取代 |
| harmony-ops(9) | hm-keeper:生态雷达+issue 流+修复计划 | **高价值,全新重写**(Phase 3 主项) | 旧线从未接入主力 profile(编排复杂);但其**行为规格是金子**:见下节 |
| harmony-cybernetics(3) | 感知/世界模型/反馈事件流 | **思路吸收,暂不实现** | 与新线 insights.jsonl 同构;增益归因(哪个技能带来了提升)是好问题,Phase 3 末再评估 |
| harmony-knowledge / tui | 空目录占位 | 无内容 | — |

## 已完成的迁移(本次)

1. **三个种子技能全文导入**新线技能库(active,即时生效):
   - `cangjie-win-static-pitfalls`(仓颉 Windows 静态运行时缺陷与实证缓解)
   - `cjpm-build-repair`(cjpm 构建失败修复:CANGJIE_HOME/junction/干净重建)
   - `hdc-device-ops`(hdc 例行操作手册,[Empty] 语义等)
2. **踩坑事实**早已沉淀:RESEARCH-2026.md 反面教材(发行版维护税四笔账)、hvigor 三坑、真机回路验证结论。
3. **37 家模型供应商 yaml** → 不需要:新线 Provider 只要 OpenAI 兼容 baseUrl 一项即通吃,这正是零依赖内核的红利。

## hm-keeper 行为规格(重写时的硬约束,来自旧线 core.ts 实读)

- 生态雷达:拉 OpenHarmony/华为生态源 → 与上次快照 diff → LLM 生成中文简报;**网关不可达降级为模板拼接,单源失败不拖垮整轮**(容灾三段式照抄)
- issue 流:**AI 只起草、人批准才发布**——精确口令确认(旧线为 `"user approved issue <n>"`)、绝不自动关闭 issue、发布评论必带身份标识
- PR 一律 draft 模式+方案卡
- 新线落点:做成 domain 包 `@hmh/domain-ops` + MCP 借力(用社区 GitHub MCP server 而非自写 API 封装)——旧线没赶上的生态红利

## 新线 backlog(按优先级)

1. `@hmh/domain-ops` hm-keeper 重写(雷达+issue,行为规格如上)
2. cjpm 工具(harmony_cjpm_build/test 等价物)——仓颉是新线尚未覆盖的鸿蒙语言面
3. see_image(模型看图,供 UI 调试)
4. codelinter 包装(需依赖论证:官方 CLI 子进程调用,无 npm 依赖则不触红线)
5. 工程脚手架多模板选型清单(从旧线 scaffold 模板树抄目录结构)

## 结论

旧线最值钱的三样东西——**运维管家的行为规格、仓颉生态的踩坑技能、发行版维护税的教训**——前两样本次已入库/成文,第三样是新线立项动机本身。代码层面无一值得搬运:新线在工具链深度(真机全回路)、进化严谨性(holdout 门禁)、安全(内核级审批)上均已超过旧线对应物。
