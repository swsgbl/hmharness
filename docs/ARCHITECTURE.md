# hmharness 架构

## 分层

```
┌────────────────────────────────────────────────┐
│  前端  cli(终端:REPL/一次性/evolve/web/cognitive│
│        /lsp/browser/acp-serve)                  │
│        web(浏览器:SSE 推流+远程审批+会话回放     │
│              +/api/cognitive 研究面板)           │
│        acp-serve(ACP 服务器:BrowserOS 助手面板  │
│              等外部宿主像调 Codex 一样调 hmh,    │
│              ndjson JSON-RPC+审批卡+会话复用)    │
├────────────────────────────────────────────────┤
│  代码智能层 lsp(LSP 3.18 Client/Manager,2026-10)│
│   registry(PATH+DevEco-local 官方发现/健康探测/  │
│     来源分级,绝不自动下载)                       │
│   client(握手/请求/诊断推送)process-manager     │
│   (cwd 绑定+env 清洗+重启预算+killSync)          │
│   trust(Capability OS 首片:sha256 钉住+篡改拒执)│
│   tools(Tier-0/1 只读工具,diagnostics 恒标注    │
│     source:lsp=反馈非证明)                       │
├────────────────────────────────────────────────┤
│  认知层 cognitive(2026-09 蓝图,Cognitive OS)     │
│   environment 协议+注册表(observe/act/snapshot/ │
│     restore/evaluate 一致性测试+snapshotClass   │
│     三分类:deterministic/forkable/observational)│
│   world-model(信念表+预测置信+误差聚类+修订+    │
│     WM2.0 结构化增量 stateDiff/predictDelta)     │
│   goal(图谱/分解/漂移/高影响审批)               │
│   exploration(不确定性×信息增益×相关性−风险)    │
│   slice(纵切片:Observe→Goal→Plan→Act→          │
│     独立Evaluate→Learn,claim-blind 类型级隔离)  │
│   crowd(群体回路:匿名摘要/指纹匹配/absorb)      │
│   rlm(worker 沙箱:崩溃隔离+秘密不继承+硬终止)   │
│   memory 五层(working/episodic/semantic/        │
│     procedural/world+溯源+矛盾检测+只增巩固+    │
│     分词计分检索)                                │
│   skill-compiler(经验→可验证技能→门禁晋升+      │
│     n-gram 工作流归纳+失败反模式警示)            │
│   continual(学习控制平面:九类对象,harness优先)  │
│   evolution2(候选契约/序贯门禁/金丝雀/审计/     │
│     reward-hacking 检测)                        │
│   multi-agent(角色契约/共享黑板/预算/心跳/取消) │
│   benchmark(GeneralBench 统一指标+transfer lab+ │
│     三臂阶梯 ladder3:Model-only vs +Harness vs  │
│     +Cognitive OS)                              │
├────────────────────────────────────────────────┤
│  环境层 environments(Cognitive OS 适配器)        │
│   terminal(原生:文件/命令/评估探针)             │
│   harmonyos(hdc 桥)/browser(CDP 观察+桥接动作+  │
│     CdpActBridge 钉住页目标+加载等待)           │
│   desktop(窗口枚举+自动化桥)/arc3(官方 REST     │
│     全桥+帧渲染+视觉实玩+记分卡)                 │
├────────────────────────────────────────────────┤
│  浏览器执行层 browser(BrowserOS AI 浏览器,      │
│   2026-10 第 15 包)                             │
│   browser_* 八件套(navigate/snapshot/click/    │
│     type/read/scroll/screenshot/tabs)           │
│   专用实例(:9223+HMH_HOME/browser/profile,      │
│     永不碰日常浏览器;ACP 场景 attach 宿主标签页) │
│   trust(sha256 信任钉,同 LSP 契约)             │
├────────────────────────────────────────────────┤
│  浏览器扩展层 extension(2026-10 第 16 包)       │
│   扩展桥:接入用户真实浏览器(Chromium 系/       │
│   Firefox/Safari 载荷;ChatGPT 式回环服务+      │
│   一次性配对码,fetch 流 SSE+POST,无 eval 面)  │
│   extension_* 四件套(status/tabs/page_read/    │
│   page_act——真实页面操作恒审批;状态文件判活,  │
│   未连接即不注册——死工具纪律)                  │
├────────────────────────────────────────────────┤
│  执行层 agent(工具·系统提示·spawn_agent·runner) │
├────────────────────────────────────────────────┤
│  域层  domain-harmony(设备/工具链/构建/安装/运行/日志)│
│       + MCP 生态工具投影(5800+ 服务器)           │
├────────────────────────────────────────────────┤
│  进化层 evolution(一等公民,非插件)               │
│   memory ── 跨会话持久记忆(检索式注入,只增不删)  │
│   skills ── 技能库三态(draft→active→archive)     │
│   insights 洞察自动捕获(每会话落 jsonl)           │
│   bench ── 基准用例(训练/保留双集)               │
│   evolve ── 进化循环(起草→A/B门禁→晋升/回滚)     │
├────────────────────────────────────────────────┤
│  内核 kernel(零依赖)                             │
│   Registry  工具注册表(唯一扩展面+审批标记)       │
│   Loop      智能体循环(LLM↔工具 until 完成)      │
│             + 审批门禁 + 上下文压缩               │
│   Provider  OpenAI 兼容适配器(流式+思考块)        │
│   Mcp       MCP 客户端(stdio+HTTP,工具投影)      │
│   Session   追加式 JSONL 审计日志(含审批事件)     │
│   Config    HMH_HOME 隔离状态根                  │
└────────────────────────────────────────────────┘
```

十六包依赖方向(自上而下,禁止反向):cli/web → cognitive + environments +
lsp + browser + extension + agent → evolution + domain-harmony → kernel。
lsp 只依赖 kernel(代码智能不依赖认知策略);browser 独立成包
(浏览器执行是环境能力,不与认知层耦合);extension 同理独立
(真实浏览器接入是环境能力,仅依赖 kernel 的 Tool 类型)。
cli 与 web 互为兄弟前端,共享 agent 层的 runner 事件协议(onDelta/onToolCall/onApproval/onFinal),
行为完全一致——终端与浏览器只是同一事件流的两张皮。
acp-serve 是第三个前端:宿主驱动的会话流(与用户驱动的 cli/web 对偶),
同一 runner 同一门禁,协议层适配 ACP ndjson。
cognitive 只依赖 kernel:认知策略不碰审批/沙箱内部,治理组合它们而非绕过它们。

## 关键决策及依据(立项调研存档于本地)

| 决策 | 依据 |
|---|---|
| while-循环内核,拒绝重框架 | 2026 共识"loop engineering":Anthropic 等——简单循环+显式终止+上下文管理即最优;"boring architecture wins in production" |
| MCP 客户端 Phase 1 就做 | MCP 已成事实标准(月 SDK 下载约 2 亿,服务器 5800+);工具借生态不重造 |
| MCP 客户端手写而非引 SDK | 内核零依赖红线;MCP 线上协议就是 JSON-RPC 2.0+两种传输,量小可控,SDK 依赖树与红线冲突 |
| MCP 工具默认受审批门禁 | 远端能力不可静态审计;trusted 服务器可显式豁免——远程能力从保守缺省开始 |
| 进化什么=技能/记忆/经验/代码 | DGM(2025)→2026 研究焦点:进化对象应是 skill library 与跨会话经验;2026-09 起加入**代码补丁轨道**(patches.ts)——只改提示词学"怎么做",能改代码才学"能做什么"(DGM 桥) |
| bench 作为进化门禁 | DGM 教训:无适应度信号的自改进=漂移;变更必须先过基准再晋升;技能与代码补丁共用同一门禁纪律(双样本) |
| 进化循环写 skills/+memory/+可提代码补丁 | Misevolve(CoRR 2509.26354, 2025)与 DGM 目标漂移教训:自改进程不得触碰安全配置。**代码补丁四条件**:只允许 packages/.../src/*.ts、永禁 kernel loop/provider/config/security(自举悖论防护)、只在隔离 git 分支沙箱、必过双样本门禁+回归即回滚 |
| 记忆只增不删+检索注入,蒸馏叠加其上 | ACE(arXiv:2510.04618):重写即遗忘;追加式进化保留原始上下文。蒸馏(distill)已在进化循环落地:每轮在只增原始记忆之上生成精炼摘要层,原始记录永不删除 |
| 审批门禁做进循环内核 | 门禁点必须单一(执行前一秒)才能不漏;工具自审或前端代审都会有旁路 |
| 上下文压缩=确定性裁剪 | 零模型调用的确定性预算裁剪(tool 输出占大头)已上线并覆盖 Phase 2;模型摘要式压缩作为预算裁剪兜不住时的后续升级 |
| **三层即时反馈**(2026-09) | 批处理式学习太慢:系统级错误(命令不存在/认证失败)重试不会自愈——Tier1 阈值 1 即记;Tier2 每个出错任务完成即一次小模型反思入记忆(下任务即受益);Tier3 全进化轮每 3 洞察 |
| **并行工具执行,审批串行** | 模型一轮请求的多个工具,审批必须逐个问(单门禁保序防竞态),已批准工具 Promise.all 并发——独立调用不再串行 |
| **Windows 宿主事实注入提示词+工具层硬墙** | 实测证明:提示词防线对模型习惯性行为不够(Unix 管道 10 次重复),关键约束必须工具层硬执行(预检拒绝+给 cmd 等价+重复失败第 3 次短路) |
| **桌面/浏览器自动化走可见路线** | Windows 无头浏览器经 child_process 输出全空(平台限制,多种参数组合实测);可见浏览器+桌面三件套(截图+点击+输入)是诚实原语——看→动→验闭环 |
| Node 22+TS | 鸿蒙工具链(hvigor/ohpm)本身 Node 系;三运行时对比中 Node=稳定+兼容王 |
| npm workspaces | 单仓四包全自有,无 file: 依赖陷阱,零外部插件机制复杂度 |
| 零依赖内核 | Node 22 原生 fetch 够用;依赖越少,上游破坏面越小 |

## 隔离契约(不可退让)

- 所有状态在 `HMH_HOME`(env 可覆盖,默认 `~/.hmharness`)
- 不读不写任何其他 harness 的家目录/注册表/环境
- 仓库零密钥;密钥只在 HMH_HOME/config.json 或环境变量
- 工具执行 deny-first(破坏性命令模式硬拒)

## 扩展面

一切能力=注册表里的一个 Tool(name/description/JSONSchema/execute)。
- 域工具:直接写包注册(harmony_* 即此法)
- 生态工具:Phase 1 的 MCP 客户端把远端服务器工具投影成同形 Tool
- 进化的产物(新技能/改提示):走 skills 目录+bench 门禁,不改代码热生效
