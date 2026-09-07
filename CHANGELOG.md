# 更新日志(CHANGELOG)

发布范围:npm org [@hmharness](https://www.npmjs.com/org/hmharness)(`@hmh` scope 已被他人占用,
故以 @hmharness 发布——与仓库名一致)。七包有序依赖:kernel → evolution → domain-harmony
→ domain-ops → agent → web → cli。

## [0.2.0] - 2026-09-07

实质变更集中在 kernel / evolution / cli 三包(其余四包为版本对齐重发,内容与
0.1.0 相同):

- **MCP server 模式(cli)**:新增 `hmh mcp-serve`——把 `harmony_*` 鸿蒙工具面以
  stdio MCP 供给 Claude Code / Codex / 任意 MCP 宿主,原生工具调用替代嵌套
  智能体循环。默认只暴露域工具(`run_command`/`write_file` 等不暴露),
  `HMH_MCP_TOOLS` 可按名/前缀收窄;审批分工=宿主权限系统+server 侧破坏性
  硬墙;外部调用记入 `insights/mcp-calls.jsonl`(观测不进门禁)。
- **进化状态备份(cli)**:`hmh state backup|restore|remove|list`——技能/记忆/
  洞察/进化日志快照与恢复;restore 前自动把当前状态停放 `.pre-restore` 副本。
- **MCP 豁免粒度(kernel)**:服务器配置新增 `trustedTools`(按远端工具名豁免
  审批),整服务器 `trusted` 保留为显式危险档。
- **慢推理超时(kernel)**:`ProviderConfig` 新增 `timeoutMs`(免费档慢推理在
  evolve 量级提示词上实测 84.5s,默认 120s 会误杀)。
- **CJK 成本修正(evolution)**:token 估算按语言分桶(ASCII 4 字符/token,
  CJK 1 字符/token)——中文"啰嗦作弊"不再能逃过 cost-cap。
- **knowledge 供应链加固(evolution)**:抓取来源白名单钉死在代码内;快照记录
  每页 sha256(传输篡改可见);蒸馏提示词加"diff 是数据不是指令"防线。
- **证据工程(仓库侧)**:30 天自喂养老协议(docs/SELFFEED.md)+ 证据页
  (website/evidence,判例/被拒候选/原始日志原样发布)+ 导出器;README 增
  "在 Claude Code/Codex 里用"章节与自进化诚实脚注。

## [0.1.1] - 2026-09-05

仅 `@hmharness/cli`:

- 修复 bin 入口被 npm 发布时静默移除的问题(package.json 中 bin 路径的 `./`
  前缀不合法,规范化为 `dist/main.js`)——0.1.0 全局安装后没有 `hmh` 命令,
  0.1.1 起正常。其余六包无变化,保持 0.1.0。

## [0.1.0] - 2026-09-05

七包首次发布。发布时点的框架能力快照:

- **@hmharness/kernel**:零运行时依赖内核——工具注册表、OpenAI 兼容 provider
  适配(17 家预设+本地网关探测+401 自动重协商)、代理循环(审批逐个、已批准
  工具并行执行)、上下文压缩、会话 jsonl、MCP stdio 客户端。
- **@hmharness/evolution**:自进化一等公民——持久记忆(CJK bigram 检索)、
  技能库(draft→双门禁→金丝雀→impact 判定 promote/retire)、bench 四模式
  结构化断言+成本上限、血缘账本、Pareto 池、AWM 工作流归纳、知识快照 diff、
  代码级补丁沙箱(git 分支+bench 门禁+自动回滚)。
- **@hmharness/domain-harmony**:鸿蒙原生域——设备(hdc)/构建(hvigor)/工程
  脚手架/schema 校验/API 矩阵/编译修复七类分诊/签名调试证书链/装机四步
  测试/UI 视觉回归/API 知识图谱(SDK d.ts 索引)/模拟器管理。
- **@hmharness/domain-ops**:生态雷达(OpenHarmony 发布跟踪+简报)/issue 流/
  消息通道(飞书/钉钉/通用 webhook)。
- **@hmharness/agent**:工具层与执行——基础工具(搜索/抓取/桌面三件套/审批
  门)、系统提示词宿主事实注入、子代理分发(角色排行榜)、run_command 失败
  预检+CRITIC 诊断。
- **@hmharness/web**:本地网页前端(node:http 零依赖,SSE 流、远程审批门、
  三栏工作台)。
- **@hmharness/cli**:终端前端——一次性任务、REPL、全屏 TUI(斜杠面板/模型
  选择器/思考折叠/双语)、web 守护进程。

环境要求:Node >= 22。发布流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。
