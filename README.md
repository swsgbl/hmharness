# hmharness

**为鸿蒙开发工程全流程而生的自进化智能体框架。** Clean-room 全新设计:借 2026 年业界最佳理念(循环工程 / MCP / 技能库进化),不继承任何运行时依赖。

## 设计原则

1. **内核极简,能力外挂** —— 内核只有注册表+循环+提供商+会话,零运行时依赖(Node ≥22 原生 fetch)。"Boring architecture wins."
2. **自进化是一等公民** —— 记忆(memory)、技能库(skills)、洞察(insights)、基准(bench)是内核级子系统,不是插件。这正是本框架存在的理由。
3. **鸿蒙是原生域** —— hdc/hvigor/ohpm/签名/工程模板是一等域模块(harmony_* 工具),不是外挂功能。
4. **彻底隔离** —— 全部状态在 `HMH_HOME`(默认 `~/.hmharness`),与机器上任何其他 harness 零共享、零冲突。
5. **MCP 生态借力** —— 工具协议原生兼容 MCP(Phase 1),5800+ 社区服务器即插即用,不重造轮子。

## 快速开始

```bash
npm install
npm run build               # tsc 编译四包产物(首次使用编译版 CLI 前执行)
npm run hmh -- init         # 建立 ~/.hmharness(配置+状态目录)
npm run hmh -- check        # 鸿蒙工具链体检(hdc/hvigorw/ohpm)
npm run hmh -- devices      # 列出连接的鸿蒙设备/模拟器
npm run hmh -- "你的任务"   # 一次性任务(完整智能体循环,流式输出)
npm run hmh                 # 交互 REPL(跨行保留对话记忆)
npm run hmh -- resume       # 继续最近一次会话(或 resume <id前缀>)
npm run hmh -- tools        # 全部工具清单(含 [gated] 审批标记)
npm run hmh -- mcp          # MCP 服务器状态与其工具
npm run hmh -- evolve       # 跑一轮自进化循环
npm run hmh -- bench        # 进化基准测试
npm run hmh -- skills       # 技能库清单(active + drafts)
npx hmh ...                 # 编译版入口(npm run build 之后)
```

模型接入:默认走本机 OpenAI 兼容网关(FreeRide `localhost:11343`);改 `~/.hmharness/config.json` 或环境变量 `HMH_BASE_URL / HMH_API_KEY / HMH_MODEL` 指向任意厂商(GLM/OpenRouter/vLLM/Ollama…)。

## 鸿蒙全流程(实测)

```text
harmony_project_create → harmony_build → harmony_install → harmony_launch → harmony_logs
```

`harmony_project_create` 在指定目录生成最小可构建工程(stage 模型,ArkTS,16 文件,含生成的 PNG 图标);
`harmony_build` 调用真实 hvigor(自动注入 DEVECO_SDK_HOME/NODE_HOME)。本机已实测:
脚手架 → `BUILD SUCCESSFUL in 5.5s` → 产出 `entry-default-unsigned.hap`。
SDK 目标版本可用 `HM_SDK_VERSION` 覆盖(默认 `6.1.1(24)`,modelVersion 固定 5.0.0 兼容当前 hvigor)。

## 自进化(Phase 2)

`hmh evolve` 跑一轮完整进化循环:读会话洞察 → 元模型起草候选技能(写入 `skills/draft/`)→
bench A/B 门禁(候选注入 vs 基线,任何用例回归即拒)→ 晋升(自动快照现任版本)或回滚 →
记忆蒸馏(append-only)→ 全程落 `evolution/log.jsonl`。

安全设计:草稿永不进入真实会话;进化循环只写 `skills/` 与 `memory/`,无法触碰配置与安全设置;
记忆只增不删(ACE 教训);bench 绿是晋升的唯一通道(DGM/GDPevo 教训)。

## MCP 生态接入

在 `~/.hmharness/config.json` 加 `mcpServers`,5800+ 社区服务器即插即用:

```json
{
  "mcpServers": {
    "fetch": { "type": "stdio", "command": "npx", "args": ["-y", "mcp-server-fetch"] },
    "remote": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ..." } }
  }
}
```

远端工具投影为 `mcp_<server>_<tool>` 注册进同一张注册表。**安全默认**:未标 `"trusted": true` 的服务器,其工具每次调用都走审批门禁(TTY 弹 y/N;非交互环境默认拒绝,`--yes` 或 `"approval": "auto"` 放行)。

## 权限与审批

- 写操作(write_file/run_command)与设备操作(harmony_install/launch/uninstall)声明式标记 `needsApproval`,循环内核统一执行门禁,审批结果落会话审计。
- deny-first 命令护栏(破坏性模式硬拒)仍然在最内层兜底。

## 仓库结构

```
packages/
  kernel/          @hmh/kernel        注册表·循环·提供商(流式)·会话(审计/resume)·配置·上下文压缩·MCP 客户端(零依赖)
  evolution/       @hmh/evolution     记忆(检索式)·洞察·技能库(三态管线)·基准·进化循环
  domain-harmony/  @hmh/domain-harmony 鸿蒙域工具(设备·工具链·工程脚手架·构建·安装·运行·日志)
  cli/             @hmh/cli           命令行(REPL·一次性任务·resume·evolve·bench·MCP 状态)
scripts/
  test-mcp-server.mjs  本地测试用 MCP 服务器(stdio,验证 MCP 客户端用)
  e2e-scaffold.mts     工程脚手架 E2E 探针(脚手架→真实 hvigor 构建)
docs/
  ARCHITECTURE.md  架构蓝图
  ROADMAP.md       路线图(Phase 0→3)
  RESEARCH-2026.md 立项调研依据
```

## 与 harmony-harness(旧线)的关系

并行不悖:旧线(harmony-harness,基于 DeepSeek Harness 的插件发行版)继续可用;本仓是全新框架的起点,不共享任何代码、配置或运行时。详见 docs/ROADMAP.md 的迁移策略。
