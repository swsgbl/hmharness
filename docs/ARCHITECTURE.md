# hmharness 架构

## 分层

```
┌────────────────────────────────────────────────┐
│  前端  cli(终端:REPL/一次性/evolve/web 启动)    │
│        web(浏览器:SSE 推流+远程审批+会话回放)   │
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

六包依赖方向(自上而下,禁止反向):cli/web → agent → evolution + domain-harmony → kernel。
cli 与 web 互为兄弟前端,共享 agent 层的 runner 事件协议(onDelta/onToolCall/onApproval/onFinal),
行为完全一致——终端与浏览器只是同一事件流的两张皮。

## 关键决策及依据(立项调研存档于本地)

| 决策 | 依据 |
|---|---|
| while-循环内核,拒绝重框架 | 2026 共识"loop engineering":Anthropic 等——简单循环+显式终止+上下文管理即最优;"boring architecture wins in production" |
| MCP 客户端 Phase 1 就做 | MCP 已成事实标准(月 SDK 下载约 2 亿,服务器 5800+);工具借生态不重造 |
| MCP 客户端手写而非引 SDK | 内核零依赖红线;MCP 线上协议就是 JSON-RPC 2.0+两种传输,量小可控,SDK 依赖树与红线冲突 |
| MCP 工具默认受审批门禁 | 远端能力不可静态审计;trusted 服务器可显式豁免——远程能力从保守缺省开始 |
| 进化什么=技能/记忆/经验 | DGM(2025)→2026 研究焦点:进化对象应是 skill library 与跨会话经验 |
| bench 作为进化门禁 | DGM 教训:无适应度信号的自改进=漂移;变更必须先过基准再晋升 |
| 进化循环只写 skills/ 与 memory/ | Misevolve(CoRR 2509.26354, 2025)与 DGM 目标漂移教训:自改进程不得触碰安全配置;晋升必须带快照回滚,回归即拒 |
| 记忆只增不删+检索注入 | ACE(arXiv:2510.04618):重写即遗忘;追加式进化保留原始上下文 |
| 审批门禁做进循环内核 | 门禁点必须单一(执行前一秒)才能不漏;工具自审或前端代审都会有旁路 |
| 上下文压缩=确定性裁剪 | 先做零模型调用的确定性预算裁剪(tool 输出占大头);模型摘要式压缩留给 Phase 2 按需引入 |
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
