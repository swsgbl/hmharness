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
npm run build               # tsc 编译六包产物(首次使用编译版 CLI 前执行)
npm run hmh -- init         # 建立 ~/.hmharness(配置+状态目录)
npm run hmh -- check        # 鸿蒙工具链体检(hdc/hvigorw/ohpm)
npm run hmh -- devices      # 列出连接的鸿蒙设备/模拟器
npm run hmh -- "你的任务"   # 一次性任务(完整智能体循环,流式输出)
npm run hmh                  # 交互 REPL(跨行保留对话记忆)
npm run hmh -- resume       # 继续最近一次会话(或 resume <id前缀>)
npm run hmh -- web          # 本地 Web 前端 http://127.0.0.1:7788
npm run hmh -- tools        # 全部工具清单(含 [gated] 审批标记)
npm run hmh -- mcp          # MCP 服务器状态与其工具
npm run hmh -- evolve       # 跑一轮自进化循环(--every=30 常驻)
npm run hmh -- bench        # 进化基准测试
npm run hmh -- skills       # 技能库清单(active + drafts)
npx hmh ...                 # 编译版入口(npm run build 之后)
```

模型接入:默认走本机 OpenAI 兼容网关(FreeRide `localhost:11343`);改 `~/.hmharness/config.json` 或环境变量 `HMH_BASE_URL / HMH_API_KEY / HMH_MODEL` 指向任意厂商(GLM/OpenRouter/vLLM/Ollama…)。

## Web 前端

`hmh web [--port=7788]` 启动零依赖本地服务(仅绑定 127.0.0.1):浏览器里流式看思考与回答、
工具调用实时滚动、**受门禁工具弹出批准/拒绝**(5 分钟不决策自动安全拒),侧栏是技能库/近期洞察/
进化记录/历史会话(点击回放转录)。E2E 实测:远程批准 `write_file` → 文件真实落盘。

## 鸿蒙全流程(真机实测)

```text
harmony_project_create → harmony_build → harmony_install → harmony_launch → harmony_logs
```

`harmony_project_create` 在指定目录生成最小可构建工程(stage 模型,ArkTS,含生成的 PNG 图标);
`harmony_build` 调用真实 hvigor(自动注入 DEVECO_SDK_HOME/NODE_HOME)。**已在模拟器(127.0.0.1:5555)全回路实测**:
脚手架 → `BUILD SUCCESSFUL 5.5s` → 安装成功 → `aa start` 启动成功(pages.Index 加载)→ hilog 抓到脚手架埋点 → 卸载。
SDK 目标版本可用 `HM_SDK_VERSION` 覆盖(默认 `6.1.1(24)`,modelVersion 固定 5.0.0 兼容当前 hvigor)。

## 子代理

`spawn_agent` 工具把一个自包含的子任务委派给**全新上下文**的子代理(同工具集、无 MCP、无父对话历史),
返回其最终答案——上下文隔离让长任务的探索不再撑爆主对话。深度上限 2 层,子代理工具流量以
`sub1>` 前缀审计进同一会话日志,共享同一审批门禁。

## 自进化(Phase 2 完结)

`hmh evolve [--every=30] [--cycles=N]` 跑进化循环(单次或常驻):读会话洞察 → 元模型起草候选技能
(写入 `skills/draft/`)→ **训练集** A/B 门禁(候选注入 vs 基线,回归即拒)→ 晋升(自动快照现任版本)
→ **保留集**复验(防背题,回归即回滚清退)→ 记忆蒸馏(append-only)→ 全程落 `evolution/log.jsonl`。
手工管理:`hmh skills --promote|--rollback|--unpromote <name>`。

安全设计:草稿永不进入真实会话;进化循环只写 `skills/` 与 `memory/`,无法触碰配置与安全设置;
记忆只增不删(ACE 教训);训练/保留双集都绿是晋升的唯一通道(DGM/GDPevo 教训)。

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
  evolution/       @hmh/evolution     记忆(检索式)·洞察·技能库(三态管线)·基准(含保留集)·进化循环
  domain-harmony/  @hmh/domain-harmony 鸿蒙域工具(设备·工具链·工程脚手架·构建·安装·运行·日志)
  agent/           @hmh/agent         执行层:基础工具·系统提示·spawn_agent·共享任务 runner
  cli/             @hmh/cli           终端前端(REPL·一次性任务·resume·evolve·bench·web 启动)
  web/             @hmh/web           Web 前端(node:http+SSE+远程审批+内嵌无构建 SPA)
scripts/
  test-mcp-server.mjs   本地测试用 MCP 服务器(stdio)
  e2e-device.mts        真机全回路 E2E(脚手架→构建→安装→启动→日志)
  e2e-scaffold.mts      脚手架→hvigor 构建 E2E
  e2e-evolve-gate.mts   进化门禁真实模型 E2E
  test-evolve-gate.mts  进化门禁确定性测试(桩信号,三路径断言)
docs/
  ARCHITECTURE.md  架构蓝图
  ROADMAP.md       路线图(Phase 0→3)
  RESEARCH-2026.md 立项调研依据
  MIGRATION-ASSESSMENT.md 旧线能力迁移评估(34 工具逐项判定)
```

## 与 harmony-harness(旧线)的关系

并行不悖:旧线(harmony-harness,基于 DeepSeek Harness 的插件发行版)继续可用;本仓是全新框架的起点,不共享任何代码、配置或运行时。详见 docs/ROADMAP.md 的迁移策略。
