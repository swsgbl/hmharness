# hmharness

**为鸿蒙(HarmonyOS/OpenHarmony)开发全流程而生的自进化智能体框架。** 零依赖内核 + 自进化一等公民 + MCP 生态借力——不继承任何上游运行时,能力全部自持或经标准协议外借。

[![ci](https://github.com/swsgbl/hmharness/actions/workflows/ci.yml/badge.svg)](https://github.com/swsgbl/hmharness/actions/workflows/ci.yml)
![node](https://img.shields.io/badge/node-%3E%3D22-339933)
![deps](https://img.shields.io/badge/runtime%20deps-0-000000)

## 特性一览

| 领域 | 能力 |
|---|---|
| **智能体内核** | while 循环内核、任意 OpenAI 兼容厂商、流式输出+思考块、上下文预算压缩、内核级审批门禁、追加式会话审计 |
| **鸿蒙原生域** | 工程脚手架(参数化:多页面/多模块,一句话建任意结构)、hvigor 构建、hdc 安装/启动/日志/卸载、仓颉 cjpm 构建、codelinter、**模拟器全生命周期管理(无 IDE)** |
| **自进化** | 进化循环(洞察挖掘→起草→训练/保留双集门禁→晋升/回滚)、技能三态管线、检索式长期记忆、定时进化、进化审计日志 |
| **生态借力** | MCP 客户端(stdio+HTTP,5800+ 社区服务器即插即用)、gh CLI 运维管家(生态雷达+issue 流,AI 只起草+人批准才发布) |
| **多智能体** | spawn_agent 子代理(全新上下文、深度上限、共享审批、审计前缀) |
| **视觉** | see_image(任意视觉模型,多提供商降级链) |
| **多前端** | CLI / REPL / 轻量 TUI(斜杠命令)/ Web(浏览器流式+远程审批+会话回放) |
| **国际化** | zh / en 双语界面与系统提示 |

## 快速开始

```bash
git clone https://github.com/swsgbl/hmharness.git
cd hmharness
npm install
npm run build
npx hmh init                    # 建立 ~/.hmharness(配置+状态目录)
```

配置任意 OpenAI 兼容厂商(编辑 `~/.hmharness/config.json` 或环境变量 `HMH_BASE_URL / HMH_API_KEY / HMH_MODEL`):

```json
{
  "provider": { "baseUrl": "https://api.example.com/v1", "apiKey": "sk-...", "model": "your-model" }
}
```

多厂商按用途路由(可选):

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
npx hmh "你的任务"            # 一次性任务(完整智能体循环,流式)
npx hmh                        # 交互 REPL(跨行对话记忆)
npx hmh tui                    # 轻量 TUI(状态头+斜杠命令)
npx hmh web [--port=7788]      # Web 前端(浏览器审批+会话回放)
npx hmh resume [id前缀]        # 继续历史会话
npx hmh tools | mcp            # 工具清单 / MCP 服务器状态
npx hmh check | devices        # 工具链体检 / 设备列表
npx hmh evolve [--every=30]    # 自进化循环(单次或常驻)
npx hmh bench | skills         # 基准 / 技能库
npx hmh ops scan|brief|status  # 生态雷达
```

危险操作默认走审批门禁(TTY 弹 y/N;非交互默认拒绝;`--yes` 或 `"approval":"auto"` 放行),破坏性命令模式硬拒。

## 鸿蒙全流程(零 IDE)

```text
harmony_project_create(pages+modules) → harmony_build → harmony_install
  → harmony_launch → harmony_logs           # 真机/模拟器
harmony_emulator_list|catalog|create|start|stop|delete   # 模拟器全生命周期
harmony_cjpm_build/test · harmony_lint                   # 仓颉 / codelinter
```

工程脚手架完全参数化:一次调用生成多页面 + feature HAP + har 库的任意结构;模拟器管理直接驱动官方无头 CLI,无需打开 DevEco Studio。

## 自进化

`hmh evolve` 一轮循环:读会话洞察 → 元模型起草候选技能(写入 drafts)→ **训练集** A/B 门禁(回归即拒)→ 晋升(自动快照)→ **保留集**复验(防背题,回归即回滚)→ 记忆蒸馏(只增不删)→ 全程落 `evolution/log.jsonl`。安全约束:进化循环只写 `skills/` 与 `memory/`,无法触碰配置与安全设置。

## 仓库结构

```
packages/
  kernel/          零依赖内核(注册表·循环·提供商·会话·配置·压缩·MCP 客户端)
  evolution/       记忆·洞察·技能三态·基准(训练/保留)·进化循环
  domain-harmony/  鸿蒙域(设备·工具链·脚手架·构建·安装·运行·日志·仓颉·lint·模拟器)
  domain-ops/      运维管家(生态雷达·issue 流)
  agent/           执行层(基础工具·系统提示·spawn·runner)
  cli/  web/       终端与浏览器双前端(同一事件协议)
```

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 与 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 参与贡献

`npm run typecheck && npm test && npm run build` 全绿即可提交;PR 一律 draft 模式。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

[MIT](LICENSE)
