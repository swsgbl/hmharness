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
npm run hmh -- init          # 建立 ~/.hmharness(配置+状态目录)
npm run hmh -- check         # 鸿蒙工具链体检(hdc/hvigorw/ohpm)
npm run hmh -- devices       # 列出连接的鸿蒙设备/模拟器
npm run hmh -- "你的任务"    # 一次性任务(完整智能体循环)
npm run hmh                  # 交互 REPL
npm run hmh -- skills        # 技能库清单
npm run hmh -- bench         # 进化基准测试
```

模型接入:默认走本机 OpenAI 兼容网关(FreeRide `localhost:11343`);改 `~/.hmharness/config.json` 或环境变量 `HMH_BASE_URL / HMH_API_KEY / HMH_MODEL` 指向任意厂商(GLM/OpenRouter/vLLM/Ollama…)。

## 仓库结构

```
packages/
  kernel/          @hmh/kernel        注册表·循环·提供商·会话·配置(零依赖)
  evolution/       @hmh/evolution     记忆·洞察·技能库·基准(自进化核心)
  domain-harmony/  @hmh/domain-harmony 鸿蒙域工具(设备·工具链·构建·工程)
  cli/             @hmh/cli           命令行(REPL·一次性任务·直接工具)
docs/
  ARCHITECTURE.md  架构蓝图
  ROADMAP.md       路线图(Phase 0→3)
  RESEARCH-2026.md 立项调研依据
```

## 与 harmony-harness(旧线)的关系

并行不悖:旧线(harmony-harness,基于 DeepSeek Harness 的插件发行版)继续可用;本仓是全新框架的起点,不共享任何代码、配置或运行时。详见 docs/ROADMAP.md 的迁移策略。
