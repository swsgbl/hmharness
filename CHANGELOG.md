# 更新日志(CHANGELOG)

发布范围:npm org [@hmharness](https://www.npmjs.com/org/hmharness)(`@hmh` scope 已被他人占用,
故以 @hmharness 发布——与仓库名一致)。七包有序依赖:kernel → evolution → domain-harmony
→ domain-ops → agent → web → cli。

## [0.6.0] - 2026-09-11

- **Codex 式无限执行 + 网络韧性(架构变更)**:
  - **去掉轮数上限**:默认无 turn cap,循环跑到模型给出最终答案为止(Codex
    fire-and-forget 哲学——丢任务进去,跑到完再收结果);
  - **空闲检测替代轮数上限**:连续 15 轮没有任何成功的工具调用才判定为"卡住"
    并停止——不是数轮数,而是看agent是否还在有效工作;
  - **Provider 指数退避重试**:从 2 次线性重试升级到 6 次指数退避(2s→4s→8s→
    16s→30s→30s + 随机抖动),429 尊重 Retry-After 头,网络中断(ECONNRESET/
    EAI_AGAIN/socket hang up)自动重试——**网络抖动和 API 限流不再杀死长任务**;
  - Token 安全阀从 10M 提升到 50M(足够几天连续运行);
  - 软检查点提示改为"没有轮数限制,工作到做完为止"。

## [0.5.5] - 2026-09-11

- **自动续跑(kernel/loop.ts)**:轮数上限从"硬停"改为"软检查点"——模型到达
  自适应轮数时收到"continue if not done"提示,如果还在调工具就**自动继续**,
  直到给出最终答案。硬安全阀:总轮数 5x 软上限(封顶 400)或总 token 10M。
  **长任务体验从"25轮停→手动继续"变为"丢进去跑到完"**。

## [0.5.4] - 2026-09-11

- **修复 25 轮自动停止的硬上限(kernel/loop.ts)**:maxTurns 从固定 25 改为
  **随模型上下文窗口自适应**(25~80 轮)——131K 窗口 40 轮,Claude 200K 62 轮,
  Gemini 1M 80 轮。上下文预算系统本身工作正常(用户的 950K token 会话在压缩
  管理下持续运行),瓶颈是轮数上限而非上下文。turn 耗尽消息改为可操作指引。

## [0.5.3] - 2026-09-10

- **evidence 页外推性声明**(scripts/export-evidence.cjs):黄色声明"当前数据全部
  来自自设任务,外推性未验证,待第一批外部用户数据验证"。
- **approved-rules 安全修复**(agent/runner.ts):结构化匹配替代字符串前缀——
  解析规则为 args 对象逐 key 匹配,字符串值前缀匹配但扩展部分检查 `..` 路径
  穿越(附回归测试)。
- **系统提示词 token 计数**(agent/runner.ts):每次任务输出
  `[prompt] system: N chars (~M tokens) · AGENTS.md: yes/no`。
- **预设契约冒烟测试**(scripts/preset-smoke.cjs):每厂商最小 API 调用验证
  endpoint/auth/model 三件套,退出码 1 为 CI 门。
- **雷达源新鲜度自检**(domain-ops/index.ts):扫描时检查源最新数据日期,
  >90 天标 `STALE: Nd old` 为 FAIL。
- **任务池外部信号注入器**(scripts/tasks-from-radar.cjs):雷达"值得关注"
  条目→验证任务→外部池 selffeed-tasks-ext.jsonl,打破自指适应度景观。

## [0.5.2] - 2026-09-10

- **修复 YOLO 模式形同虚设(agent/runner)**:根因是 `approvalAsk`(TUI 弹窗/
  Web 远程审批)无条件优先于 `yes` 标志——TUI 总是提供 `approvalAsk`,所以
  `/yolo` 开了弹窗照样弹。修复:`yes=true` 时跳过 `approvalAsk` 直接走
  自动批准门。这是三字符修复(`&& !opts.yes`)。附回归测试锁死。

## [0.5.1] - 2026-09-10

- **修复生态雷达"永远零新增"(domain-ops)**:根因是四个数据源已死(gitee releases
  停在 2020,github tags 停在 2024-01——OpenHarmony 已不用 releases/tags 发版)。
  源切换为 **GitHub commits API**(按 commit SHA diff),实测第二次扫描即检出
  16 条真实新增、捕捉到 OpenHarmony v7.0 Release/Beta 信号。

## [0.5.0] - 2026-09-09

- **系统提示词重写(agent/prompt.ts)**:新增 9 段工程指令(来源:Codex 开源 + DeepSeek
  Harness + hmh 自研)——持久执行、显式规划协议、并行工具调用提示、Git 工作区纪律、
  代码审查模式、分段执行、合理质疑、编辑纪律、AGENTS.md 发现。
- **edit_file 工具(agent/tools.ts)**:搜索替换替代 write_file 全量覆盖;唯一性校验
  拒绝非唯一匹配;不需审批(爆破范围限于声明的子串)。
- **AGENTS.md 被动发现(agent/runner.ts)**:从 cwd 向上扫描 AGENTS.md/CLAUDE.md/
  .cursorrules,命中自动注入 system prompt。
- **上下文预算收口信号(kernel/loop.ts)**:上下文使用量超 80% 时注入 "wrap up"
  system 消息(Codex token_budget_context + DeepSeek 80% pressure)。
- **审批持久化(agent/runner.ts)**:批准过的命令模式写入 HMH_HOME/approved-rules.json,
  后续同类命令自动放行(采纳 Codex .rules 模式)。

## [0.4.4] - 2026-09-09

- **TUI `/resume` 列出全部历史会话**(用户质询"为什么只有 8 个"):去掉
  任意"最近 N 个"上限——面板自带滚动窗+id 头前缀过滤,长列表无压力;预览
  改用 **64KB 头部窥读**(不整文件解析),实测 295 个会话全部构建预览仅
  53ms。顺带清除文本列表时代遗留的死 i18n 键。

## [0.4.3] - 2026-09-09

- **TUI `/resume` 改为活面板选择器**(用户批评修正):裸 `/resume`+Enter 打开
  可导航列表(↑↓/滚轮移动,Enter 载入选中行,Esc 关闭,输入 id 头前缀过滤,
  Tab 补全)——与 `/model` 选择器同一套交互机械;此前是打印文本列表,键盘
  无法选择(交互设计失误)。`/resume <前缀>` 直接载入保留为快捷路径。

## [0.4.2] - 2026-09-09

- **修复 TUI 网页端自动联动失效(cli)**:根因是端口被陈旧守护进程占用而状态探测
  认不出它(旧版 /api/state 响应缺字段)——每次启动都拉新进程→撞端口死掉。
  修复:探测接受任意 hmh state 形态;`hmh web stop` 新增**端口占用者驱逐**
  (netstat 定位 LISTENING PID 后 taskkill),陈旧守护从此可被可靠回收。
- **TUI `/resume`**(用户点名):`/resume` 列出最近 8 个会话(id 前缀+首条输入),
  `/resume <前缀>` 载入转录继续对话(带 i18n 双语提示)。
- **工具行折叠收紧(TUI)**:工具调用行对 `run_command` 直接显示命令本体(不再
  显示整个 JSON),工具结果固定单行 100 字符。
- **用户输入聊天气泡化(TUI)**:右对齐+上下空行分隔,与左侧模型输出形成
  "人机两侧"的视觉分区。

## [0.4.1] - 2026-09-09

- **TUI 头部显示版本号**(用户点名):每次启动第一帧即带 `⚙ hmh v0.4.x`,
  用户永远知道自己跑的是哪个构建;`/lang` 切换语言后保持。

## [0.4.0] - 2026-09-08

- **模型感知上下文工程(kernel/agent)**:上下文预算不再一刀切——context
  window 登记表(claude/glm/deepseek/gemini/gpt 等,`ProviderConfig.contextWindow`
  可显式覆盖),转录预算随窗口自适应(128K 窗口=旧默认,未知模型零变化);
  压缩新增 rolling digest:被逐内容先蒸馏成持久摘要注(随轮合并),摘要器
  故障静默降级为原剪枝行为。
- **工作区记忆隔离(evolution)**:按 workspaces.json 路径前缀识别当前工作区,
  新记忆带 `[ws:名]` 标签;检索本区提升 2.5x、他区抑制 0.3x、全局不动——
  项目事实在本项目优先,跨项目教训仍可达。旧记忆零迁移、行为不变。
- **embedding 混合检索(evolution,可选)**:配置 `routing.embedding` 后记忆
  检索升级为词法+余弦混合(OpenAI 兼容 /embeddings,向量按内容哈希缓存,
  失败回退纯词法)。
- 修复 `retrieveMemory` 的 `newest: 0` 边界:`slice(-0)` 会注入全部笔记。

## [0.3.0] - 2026-09-08

- **修复 endpoint 对 /v4 后缀基地址的拼接 bug(kernel)**:此前只认 `/v1` 后缀,
  以 `/v4` 结尾的基地址(智谱 GLM Coding Plan `open.bigmodel.cn/api/coding/paas/v4`、
  火山方舟 `/api/v3`)会被再拼上 `/v1/chat/completions` 导致 404。现在任何
  `/vN` 后缀都直接追加 `/chat/completions`(单测覆盖 v1/v3/v4/裸/尾斜杠五形态)。
  glm 预设同步更新为 Coding Plan 地址 + glm-5.3。
- **更新提醒(cli)**:REPL/TUI 启动时异步检查 npm registry 最新版(3 秒超时、
  结果缓存 24 小时、离线静默),旧版本显示一行升级提示(中英双语)。
- **`hmh ops stats`(cli)**:七包日/周/月下载量表(npm 公开 API),表下常驻
  "downloads, not users" 口径脚注。

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
