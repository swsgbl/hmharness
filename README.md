# hmharness

**为鸿蒙 (HarmonyOS/OpenHarmony) 开发全流程而生的自进化智能体框架，已升级为跨环境 Cognitive Runtime。** 零依赖内核 + 自进化一等公民 + MCP 生态借力 + 认知层（世界模型/校准/探索/迁移）——不继承任何上游运行时能力，全部自持或经标准协议外借。

[English](README.en.md) · [![ci](https://github.com/swsgbl/hmharness/actions/workflows/ci.yml/badge.svg)](https://github.com/swsgbl/hmharness/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@hmharness/cli?color=cb3837&label=npm%20%40hmharness%2Fcli)](https://www.npmjs.com/package/@hmharness/cli)
![node](https://img.shields.io/badge/node-%3E%3D22-339933)
![deps](https://img.shields.io/badge/runtime%20deps-0-000000)

![hmh CLI demo](docs/assets/hmh-demo.gif)

## 特性一览

| 领域 | 能力 |
|---|---|
| **智能体内核** | while 循环内核、任意 OpenAI 兼容厂商、流式输出（思考块）、上下文预算压缩、内核级审批门禁、追加式会话审计 |
| **🧠 认知层** | **世界模型**（信念表+预测置信+误差聚类+可解释修订）、**五层记忆**（working/episodic/semantic/procedural/world，只增不删+溯源）、**目标系统**（图谱/分解/漂移检测/高影响审批）、**探索引擎**（不确定性×信息增益×校准导向，假设可证伪）、**RLM 工作区**（跨调用持久变量+checkpoint）、**技能编译**（经验→可验证技能→门禁晋升）、**学习控制平面**（九类对象，harness 优先）、**进化 2.0 治理**（候选契约/序贯门禁/金丝雀/reward-hacking 检测/不可变审计）、**多智能体治理**（角色契约/共享预算/跨进程审计）、**校准报告**（每动作预测可靠度——harness 实证价值所在，含自进化学习曲线） |
| **🌐 环境适配** | terminal（原生）/ harmonyos（hdc 桥）/ browser（CDP）/ desktop（窗口枚举）/ **ARC-AGI-3**（官方 REST API 全桥+帧渲染+视觉模型实玩+记分卡） |
| **鸿蒙原生域** | 工程脚手架（参数化多页面/多模块，一句话建任意结构）、hvigor 构建、hdc 安装/启动/日志/卸载、仓颉 cjpm 构建、codelinter、**模拟器全生命周期管理（零 IDE）** |
| **自进化** | 进化循环（洞察挖掘 → 提案 → 训练/保留双门禁 → 晋升自动快照 → 回滚）、技能三态生命周期、检索式长期记忆（带蒸馏）、定时进化、进化审计日志；**跨环境迁移**（显式抽象动作层+双臂对照实验，校准迁移证据 +0.4166） |
| **生态借力** | MCP 客户端（stdio + HTTP，5800+ 社区服务器即插即用）、`hmh ops` 运维看家（生态雷达；AI 只起议，人批准才发布） |
| **多智能体** | spawn_agent 子代理（全新上下文、深度上限、共享审批、审计前缀）+ 角色契约拓扑治理 |
| **视觉** | see_image（任意视觉模型，多厂商降级链）+ ARC-AGI-3 帧渲染视觉实玩（模型推理随 reasoning 入档） |
| **多前端** | CLI / REPL（斜杠命令）/ **全屏 TUI（斜杠面板、滚轮翻页）** / Web（浏览器流式、远程审批、会话回放、**工作区、🧠 认知面板十区+学习曲线**） |
| **国际化** | zh / en 双语界面与系统提示（`--locale=en`） |
| **网络原生** | web_search（零密钥搜索）+ web_fetch（URL→可读文本）+ ssh_run（远程探测/运维，裸探测免审批）+ 浏览器自动化（browser_open+桌面视觉链） |
| **桌面自动化** | desktop_screenshot / desktop_click / desktop_type——看→动→验闭环，全部审批门禁 |
| **并行+即时反馈** | 多工具并发（审批保序）；三层反馈：错误即记→任务后即时反思入记忆→每 3 洞察自动进化轮；**代码级自进化**（沙箱分支+双样本门禁+git 回滚，永禁改内核循环；**默认关闭**，config 设 `evolution.autoPatch=true` 显式开启，且拒绝在脏工作树上运行） |
| **编辑分级** | edit_file 按 Codex workspace-write 分级：工作区内免审批、**HMH_HOME（审批规则本身）永远审批**、工作区外审批 |
| **会话管理** | 历史会话重命名/归档/删除（trash 可恢复），悬停操作 |
| **状态安全** | `hmh state backup|restore`——进化状态（技能/记忆/日志）快照与恢复；**认知库导出/删除**（`cognitive export/purge`，数据治理） |
| **📱 远程控制** | 手机配对（WiFi 扫码直连免密 + cloudflared 免费隧道互联网模式 + 6 位配对密码 + 自动重连） |

> **关于"自进化"的诚实注脚**:canary→impact 统计管线已就绪(暴露组 vs 对照组,≥8 会话且 ≥10% 差才晋升);**首个 30 天生产数据集已发布并归档**——[首月证据数据集 /evidence/ds-2026-09](https://swsgbl.github.io/hmharness/evidence/ds-2026-09/),判定记录、被拒候选与原始日志原样公开,30 天复盘见 [docs/SELFFEED-30d-review.md](docs/SELFFEED-30d-review.md)。首月结论:30 天内零"统计可靠"晋升(门在拒绝噪声),但协议自暴露并修复了 7 个生产缺陷;"越用越聪明"仍未证实——被证实的是门与审计面在正确工作。
>
> **平台现状**:Windows 优先(鸿蒙工具链/模拟器/桌面自动化/TUI 终端适配均在此验证);macOS/Linux 为社区支持(核心内核与进化循环是纯 Node,域工具按可用性降级)。
>
> **十三问**:零 IDE 开发鸿蒙、命令行打包签名(hapsigntool localSign 与过期证书模板)、CI/CD、防 ArkTS API 幻觉、自进化真实性、认知层学习曲线、ARC-AGI-3 考什么、手机远程控制——每条答案附证据出处:[官网 FAQ](https://swsgbl.github.io/hmharness/faq.html)(另有 [llms.txt](https://swsgbl.github.io/hmharness/llms.txt) 供 AI 检索入口)。

## 快速开始

**方式一:npm 安装**(已发布 `@hmharness/*`,推荐,零构建):

```bash
npm install -g @hmharness/cli     # Node >= 22
hmh init                    # 建立 ~/.hmharness（配置 + 状态目录）
```

> 更新是全自动的:`hmh` 启动时后台静默检查并升级——**无弹窗**,TUI 内有轻提示(更新开始/完成)与升级后首启的一行更新简报,新版本下次启动生效;`config.json` 设 `tui.autoUpdate=false` 可退回仅提示。

**方式二:源码运行**(开发/尝鲜):

```bash
git clone https://github.com/swsgbl/hmharness.git
cd hmharness
npm install
npm run build
npm link -w @hmharness/cli   # 之后任意目录直接 hmh ...
hmh init               # 建立 ~/.hmharness（配置 + 状态目录）
```

**方式三：KaihongOS / OpenHarmony 板端**（无 npm、只读根分区，一条命令装完填密钥即用）：

```bash
node scripts/install-kaihongos.cjs   # Node >= 22（路径任意，脚本自己找）
```

板端九个真实踩坑（独立挂载命名空间终端、只读根分区 remount、HOME=/ 等）与对策见 **[docs/KAIHONGOS.md](docs/KAIHONGOS.md)**。装一次即可——板上的 `hmh` 之后会经随包安装器自动静默升级（离线时按安装器内置兜底版本）。

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

## 认知层（Cognitive OS）

```bash
hmh cognitive status             # 五层记忆/轨迹库/进化审计/环境注册表
hmh cognitive world-model       # 信念表 + 校准 + 规划门（可信/存疑/未知）
hmh cognitive calibration       # 每动作预测可靠度（harness 实证价值所在）
hmh cognitive calibration --trend --env=terminal   # 自进化学习曲线
hmh cognitive explore --env=harmonyos              # 校准导向探索
hmh cognitive explore --env=browser --cdp=http://127.0.0.1:9222   # CDP 探索（无头调试浏览器）
hmh cognitive transfer --run --source=terminal --target=harmonyos  # 迁移实验
hmh cognitive play --env=arc3 --steps=10           # LLM 视觉实玩 ARC-AGI-3
hmh cognitive replay latest      # 逐步回放任意轨迹（含模型推理）
hmh cognitive diagnose | learn   # 学习机会诊断 | harness 层学习环
hmh cognitive slice "任务" --check="验证命令"    # 认知纵切片：观察→目标→计划→执行→独立评估→学习
hmh cognitive ablate --task --ladder3            # 三臂阶梯实验（Model-only vs +Harness vs +Cognitive OS）
hmh cognitive summary           # 匿名经验摘要（内容零泄露，可分享）
hmh cognitive absorb --from=<https-url>          # 吸收群体经验包为本机先验（指纹匹配/本地优先）
hmh lsp list | trust <id> | untrust <id>         # 语言服务器发现/健康/来源信任+sha256 钉住
```

每次任务自动落认知轨迹（工具动作+预测+结果+耗时，按工具归因到 browser/desktop/harmonyos/terminal 各环境）；世界模型从历史学习并反哺系统提示；探索引擎优先探测模型预测最差的动作（预测误差=信息增益）；校准可靠度随使用提升——**"越用越准"有学习曲线为证**（五环境全有读数：terminal/harmonyos/browser/arc3 四环境 improving，desktop 完美校准 flat 1.00）。

研究基建（库层，随 `@hmharness/cognitive` 提供）：**MEA 长任务闭环**（Manager 分解/新鲜执行者零转录污染/claim-blind 只读审计/学习者键审计裁决）；**版本化评测任务集**（datasetHash+seed+holdout 门+配对 McNemar 精确检验）；**观测因果挖掘与反事实重放**（时序 lag+Occam 抑制；观测因果学能排序不能排除——诚实标签恒随行）；**Code World Model**（LSP 传感器→五类本体，编辑预测先行+实际后置误差结算）。

## 仓库结构

```
packages/
  kernel/          零依赖内核（注册表、循环、提供商、会话、配置、压缩、MCP 客户端）
  cognitive/       认知层（环境协议、世界模型、目标、探索、五层记忆、技能编译、
                   学习控制平面、进化 2.0 治理、多智能体、GeneralBench、迁移、校准）
  environments/    环境适配器（terminal 原生、harmonyos、browser、desktop、ARC-AGI-3）
  evolution/       记忆·洞察·技能生命周期·基准（训练/保留）·进化循环
  domain-harmony/  鸿蒙域（设备、工具链、脚手架、构建、安装、运行、日志、仓颉、lint、模拟器）
  domain-ops/      运维看家（生态雷达、issue 流）
  agent/           执行层（基础工具、系统提示、spawn、runner、认知记录器）
  cli/  web/       终端与浏览器双前端（同一事件协议）
```

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 、[docs/ROADMAP.md](docs/ROADMAP.md) 与 [docs/PROVIDERS.md](docs/PROVIDERS.md)(常用厂商配置参考) 与 [docs/DEVLOG.md](docs/DEVLOG.md)（开发日志）;交互设计定案见 [docs/DESIGNS.md](docs/DESIGNS.md)——改 UI 行为前先查台账。

## 参与贡献

`npm run typecheck && npm test && npm run build` 全绿即可提交；PR 一律 draft 模式。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

[MIT](LICENSE)
