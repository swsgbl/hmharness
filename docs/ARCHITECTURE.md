# hmharness 架构

## 分层

```
┌────────────────────────────────────────────────┐
│  前端(Phase 1=CLI/REPL → 2=TUI → 3=Web)          │
├────────────────────────────────────────────────┤
│  域层  domain-harmony(设备/构建/工程/签名)        │
│       + 未来其他域                                │
├────────────────────────────────────────────────┤
│  进化层 evolution(一等公民,非插件)               │
│   memory ── 跨会话持久记忆(读写进系统提示)        │
│   skills ── 技能库(SKILL.md 目录制)              │
│   insights 洞察自动捕获(每会话落 jsonl)           │
│   bench ── 基准用例(进化的适应度信号)             │
├────────────────────────────────────────────────┤
│  内核 kernel(零依赖)                             │
│   Registry  工具注册表(唯一扩展面)               │
│   Loop      智能体循环(LLM↔工具 until 完成)      │
│   Provider  OpenAI 兼容适配器(任意厂商)           │
│   Session   追加式 JSONL 审计日志                 │
│   Config    HMH_HOME 隔离状态根                  │
└────────────────────────────────────────────────┘
```

## 关键决策及依据(2026-08-26 调研,见 RESEARCH-2026.md)

| 决策 | 依据 |
|---|---|
| while-循环内核,拒绝重框架 | 2026 共识"loop engineering":Anthropic 等——简单循环+显式终止+上下文管理即最优;"boring architecture wins in production" |
| MCP 客户端 Phase 1 就做 | MCP 已成事实标准(月 SDK 下载 9700 万,5800+ 服务器);工具借生态不重造 |
| 进化什么=技能/记忆/经验 | DGM(2025)→2026 研究焦点:进化对象应是 skill library 与跨会话经验 |
| bench 作为进化门禁 | DGM 教训:无适应度信号的自改进=漂移;变更必须先过基准再晋升 |
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
