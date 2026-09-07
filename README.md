# hmharness

**为鸿蒙 (HarmonyOS/OpenHarmony) 开发全流程而生的自进化智能体框架。** 零依赖内核 + 自进化一等公民 + MCP 生态借力——不继承任何上游运行时能力，全部自持或经标准协议外借。

[English](README.en.md) · [![ci](https://github.com/swsgbl/hmharness/actions/workflows/ci.yml/badge.svg)](https://github.com/swsgbl/hmharness/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@hmharness/cli?color=cb3837&label=npm%20%40hmharness%2Fcli)](https://www.npmjs.com/package/@hmharness/cli)
![node](https://img.shields.io/badge/node-%3E%3D22-339933)
![deps](https://img.shields.io/badge/runtime%20deps-0-000000)

![hmh CLI demo](docs/assets/hmh-demo.gif)

## 特性一览

| 领域 | 能力 |
|---|---|
| **智能体内核** | while 循环内核、任意 OpenAI 兼容厂商、流式输出（思考块）、上下文预算压缩、内核级审批门禁、追加式会话审计 |
| **鸿蒙原生域** | 工程脚手架（参数化多页面/多模块，一句话建任意结构）、hvigor 构建、hdc 安装/启动/日志/卸载、仓颉 cjpm 构建、codelinter、**模拟器全生命周期管理（零 IDE）** |
| **自进化** | 进化循环（洞察挖掘 → 提案 → 训练/保留双门禁 → 晋升自动快照 → 回滚）、技能三态生命周期、检索式长期记忆（带蒸馏）、定时进化、进化审计日志 |
| **生态借力** | MCP 客户端（stdio + HTTP，5800+ 社区服务器即插即用）、`hmh ops` 运维看家（生态雷达；AI 只起议，人批准才发布） |
| **多智能体** | spawn_agent 子代理（全新上下文、深度上限、共享审批、审计前缀） |
| **视觉** | see_image（任意视觉模型，多厂商降级链） |
| **多前端** | CLI / REPL（斜杠命令）/ **全屏 TUI（斜杠面板、滚轮翻页）** / Web（浏览器流式、远程审批、会话回放、**工作区**） |
| **国际化** | zh / en 双语界面与系统提示（`--locale=en`） |
| **网络原生** | web_search（零密钥搜索）+ web_fetch（URL→可读文本）+ 浏览器自动化（browser_open+桌面视觉链） |
| **桌面自动化** | desktop_screenshot / desktop_click / desktop_type——看→动→验闭环，全部审批门禁 |
| **并行+即时反馈** | 多工具并发（审批保序）；三层反馈：错误即记→任务后即时反思入记忆→每 3 洞察自动进化轮；**代码级自进化**（沙箱分支+双样本门禁+git 回滚，永禁改内核循环） |
| **会话管理** | 历史会话重命名/归档/删除（trash 可恢复），悬停操作 |
| **状态安全** | `hmh state backup|restore`——进化状态（技能/记忆/日志）快照与恢复，restore 前自动停放当前状态 |

> **关于"自进化"的诚实注脚**:canary→impact 统计管线已就绪(暴露组 vs 对照组,≥8 会话且 ≥10% 差才晋升),但首个 30 天生产数据集仍在收集中——判定记录、被拒候选与原始日志原样发布在 [证据页 /evidence](https://swsgbl.github.io/hmharness/evidence/),协议见 [docs/SELFFEED.md](docs/SELFFEED.md)。在数据集发布前,"越用越聪明"是机制而非已证事实。
>
> **平台现状**:Windows 优先(鸿蒙工具链/模拟器/桌面自动化/TUI 终端适配均在此验证);macOS/Linux 为社区支持(核心内核与进化循环是纯 Node,域工具按可用性降级)。

## 快速开始

**方式一:npm 安装**(已发布 `@hmharness/*`,推荐,零构建):

```bash
npm install -g @hmharness/cli     # Node >= 22
hmh init                    # 建立 ~/.hmharness（配置 + 状态目录）
```

**方式二:源码运行**(开发/尝鲜):

```bash
git clone https://github.com/swsgbl/hmharness.git
cd hmharness
npm install
npm run build
npm link -w @hmharness/cli   # 之后任意目录直接 hmh ...
hmh init               # 建立 ~/.hmharness（配置 + 状态目录）
```

配置任意 OpenAI 兼容厂商（编辑 `~/.hmharness/config.json` 或环境变量 `HMH_BASE_URL / HMH_API_KEY / HMH_MODEL`）：

```json
{
  "provider": { "baseUrl": "https://api.example.com/v1", "apiKey": "sk-...", "model": "your-model" }
}
```

多厂商按用途路由（可选）：

```json
{
  "providers": {
    "a": { "baseUrl": "...", "apiKey": "...", "model": "strong-model" },
    "v": { "baseUrl": "...", "apiKey": "...", "model": "vision-model" }
  },
  "routing": { "chat": "a", "vision": "v", "evolve": "a" }
}
```

## 常用命令

```bash
hmh "你的任务"             # 一次性任务（完整智能体循环,流式）
hmh                         # 交互 REPL（跨行对话记忆,/help 命令集）
hmh tui                     # 全屏 TUI（斜杠面板 ↑↓/滚轮/点击 选择、/model 选择器、/lang 中英切换;默认同时后台启动网页端,--no-web 关闭）
hmh web start               # Web 前端后台静默启动(无窗口,关终端不影响;stop 停止/status 看状态)
hmh web [--port=7788]       # Web 前端前台运行(调试用)
hmh resume [id前缀]          # 继续历史会话
hmh tools | mcp             # 工具清单 / MCP 服务器状态
hmh check | devices         # 工具链体检 / 设备列表
hmh evolve [--every=30]     # 自进化循环（单次或常驻）
hmh bench | skills          # 基准 / 技能库
hmh ops scan|brief|status   # 生态雷达
hmh --help                  # 完整用法
```

所有命令支持 `--locale=zh|en`。危险操作默认走审批门禁（TTY 问 y/N；非交互默认拒绝；`--yes` 或 `"approval":"auto"` 放行；破坏性命令模式硬拒绝）。

## 在 Claude Code / Codex 里用（MCP 服务器模式）

hmharness 可以把鸿蒙工具链以 **MCP 原生工具**的形式供给任何 MCP 宿主（Claude Code、Codex、Cursor……）——外层智能体直接调用 `harmony_build`、`harmony_api_lookup` 等工具，无嵌套智能体循环，工具调用按宿主自身的权限系统逐个确认：

```jsonc
// Claude Code: claude mcp add hmharness -- npx -y @hmharness/cli mcp-serve
// 或 .mcp.json / Codex 配置:
{ "mcpServers": { "hmharness": { "command": "npx", "args": ["-y", "@hmharness/cli", "mcp-serve"] } } }
```

- 默认只暴露 `harmony_*` 域工具（构建/装机/日志/签名/API 检索/雷达）；`run_command`、`write_file` 等通用工具不暴露（宿主有自己的）。可用环境变量 `HMH_MCP_TOOLS="harmony_build,harmony_ops"` 收窄；
- 审批分工：宿主权限系统负责"问用户"，工具内部的破坏性硬墙（deny 红线）永驻 server 侧；
- 外部智能体的每次调用记入 `insights/mcp-calls.jsonl`（只做观测，不进技能门禁——自进化专属原生会话）。

> 说明:MCP 模式是"鸿蒙工具箱出口";hmh 的自进化(记忆/技能/门禁)只在原生 `hmh` 会话中运行——两种用法互补,见 `docs/SELFFEED.md`。

## 鸿蒙全流程（零 IDE）

```text
harmony_project_create(pages+modules) → harmony_build → harmony_install
  → harmony_launch → harmony_logs                      # 真机或模拟器
harmony_emulator_list|catalog|create|start|stop|delete  # 模拟器全生命周期
harmony_cjpm_build/test · harmony_lint                  # 仓颉 / codelinter
```

工程脚手架完全参数化：一次调用生成多页面 + feature HAP + har 库的任意结构；模拟器管理直接驱动官方无头 CLI，无需打开 DevEco Studio。

## 自进化

`hmh evolve` 一轮循环：读会话洞察 → 元模型提议候选技能（写入 drafts）→ **训练门** A/B 基准（回归即拒）→ 晋升（自动快照）→ **保留门** 晋升后复验（防背题；回归即回滚）→ 记忆蒸馏（只增不删的原始记录之上生成精炼层）→ 全程落 `evolution/log.jsonl`。安全约束：进化循环只写 `skills/` 与 `memory/`，无法触碰配置与安全设置。

## 仓库结构

```
packages/
  kernel/          零依赖内核（注册表、循环、提供商、会话、配置、压缩、MCP 客户端）
  evolution/       记忆·洞察·技能生命周期·基准（训练/保留）·进化循环
  domain-harmony/  鸿蒙域（设备、工具链、脚手架、构建、安装、运行、日志、仓颉、lint、模拟器）
  domain-ops/      运维看家（生态雷达、issue 流）
  agent/           执行层（基础工具、系统提示、spawn、runner）
  cli/  web/       终端与浏览器双前端（同一事件协议）
```

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 、[docs/ROADMAP.md](docs/ROADMAP.md) 与 [docs/PROVIDERS.md](docs/PROVIDERS.md)(常用厂商配置参考) 与 [docs/DEVLOG.md](docs/DEVLOG.md)（开发日志）;交互设计定案见 [docs/DESIGNS.md](docs/DESIGNS.md)——改 UI 行为前先查台账。

## 参与贡献

`npm run typecheck && npm test && npm run build` 全绿即可提交；PR 一律 draft 模式。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

[MIT](LICENSE)
