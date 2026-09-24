# HarmonyOS / OpenHarmony 开发工具链调研报告（2025–2026）

调研日期 2026-08-27；来源以华为开发者文档 Portal API、Gitee openharmony/docs、cangjie-lang.cn 实抓为准。docs.openharmony.cn 为纯 SPA 无法直接解析，改用 Gitee 原始文件（其 6.x 文档链接已指向 GitCode 镜像）。github.com 按约束未访问。

## 1. 版本演进
【官方现状】OpenHarmony：5.0.0(API 12)→5.0.1(13)→5.0.2(14)→5.0.3(15)→5.1.0(API 18，2025 年 5 月入仓)→6.0 Release(API 20，2025-09)→6.0.0.2→6.1 Release(API 23，2026-03 入仓)。HarmonyOS 商用线：5.0.3(15)→6.0.0(20) 2025-09-25 Release→6.0.1(21)/6.0.2(22)/6.1.0(23)/6.1.1(24)→26.0.0 Beta（HDC.2026 发布，Beta2 2026-07-28）。26.0.0 起 API 版本号改 SemVer，与 OpenHarmony 底座版本号体系统一（原 X.Y.Z(N) 格式废止）。ArkTS 仍为官方首选高级语言（Sendable/TaskPool 并发、ArkCompiler）；6.0 起 ArkWeb 内核 Chromium 132、26.0.0 升 144。
【关键版本/日期】HarmonyOS SDK 26.0.0 Beta2 基于 OpenHarmony SDK 26.0.0.32（2026-07-28）。
【启示】智能体框架须以 API level 而非系统版本号做能力判定，且需兼容 SemVer 迁移期双格式。

## 2. 命令行工具链
【官方现状】官方支持无 IDE 开发：Command Line Tools 内嵌完整 SDK；`hvigorw assembleHap/App/Hsp/Har、clean、onDeviceTest/test、buildInfo、--sync`，CI 推荐 `--no-daemon`，官方《搭建流水线》文档给出 Linux CI 全流程（JDK 21@26.0.0+）；`hdc` 覆盖 install/shell/file send/hilog/tconn/fport/keygen 等约 26 组命令；`codelinter` 支持 -c 规则、--fix 自动修复、-f json、--exit-on 退出码（可入门禁）；DevEco Testing 提供 `DevEcoTestingConsole.bat/.sh -params/-taskIds/-stopTask`（需装客户端并登录）。
【关键版本】hvigorw 6.23.3（buildVersion 参数）；26.0.0 Beta2 Command Line Tools。
【启示】构建→签名→安装→测试→检查全链路可无头闭环，智能体应优先封装 hvigorw+codelinter+hdc。

## 3. 仓颉语言与 cjpm
【官方现状】华为站标注"仓颉体验版"，未升正式版；三通道 LTS/STS/Nightly，官网文档当前 1.0.1；cjpm（包管理+构建）命令：init/check/update/tree/build/run/test/clean/install/uninstall，配置 cjpm.toml（package/workspace/dependencies/交叉编译 target）。仓颉与 ArkTS 同工程混合开发、双向互调已商用落地（工行、力扣等上架 NEXT 市场）。配套：CodeArts IDE for Cangjie、VS Code 插件、毕方 AI 补全、J2CJ 迁移工具；语言内嵌 AgentDSL。源码在 gitcode.com/Cangjie。
【启示】智能体框架可把仓颉作为可选后端，但鸿蒙主线仍是 ArkTS；cjpm 命令集小而规整，易于工具化。

## 4. 工程结构规范
【官方现状】多模块工程：entry/feature HAP、应用内共享包 HSP（in-app-hsp）、静态共享 HAR；工程级 build-profile.json5（signingConfigs/products/buildModeSet/modules→targets）、模块级 build-profile.json5、module.json5（abilities/skills/extensionAbilities/shortcuts/testRunner/atomicService/routerMap；API 18 新增 Ability 重定向 abilitySrcEntryDelegator，API 23 新增 allowSelfRedirect）。oh-package.json5 管依赖。
【启示】智能体生成工程须校验三件套（app/module build-profile + module.json5）与 product/target 一致性，可用 `hvigorw buildInfo -p json` 做机读回读。

## 5. 智能体/自动化开发生态（竞品）
【官方现状】DevEco Code 已内置 Build/Plan/Goal 三种 Agent 模式：需求→代码生成→语法修复→构建出包→推送模拟器→自动验证→迭代修复的全自动流水线（Goal 模式），与本项目定位直接重叠。CodeGenie 演进：自定义智能体、MCP 配置（6.0.1 Beta1 起；6.1.0 Beta2 支持 npx/uvx 路径与 MCP Market）、Skills（6.1.0.830）、自定义指令、Ollama 三方模型、长期记忆、UI Verification 工具；26.0.0 新增 Code Scanner、8 档断点 UI 预览、Car 模拟器远控。系统侧：Agent Framework Kit（拉起智能体 UI 控件+A2A）、端侧 A2A 框架（API 24 起，AgentCard 能力描述）。社区：Gitee 搜索 API 未返回有效鸿蒙智能体仓库，GitHub 不可达，无法穷举。
【启示】差异化空间在"脱离 DevEco GUI 的开放编排层+跨仓库批量化"；可直接对接 MCP 生态。

## 6. 模拟器管理（Emulator CLI）
【官方现状】6.1.0 Release 起 Command Line Tools 集成 Emulator；命令覆盖：`-list[-details]`（含 apiVersion/isRunning/hdc 端口）、`-imageList/-install/-uninstall`（镜像）、`-create`（deviceType/osVersion/屏幕/内存/热启动）、`-delete/-stop/-start`（-bootMode coldboot|snapshot|reset，-noWindow 无界面，26.0.0 Beta1 起支持 Linux）、`-config/-unset`、`-logZip`、`-license accept`、场景模拟（旋转/音量/折叠态/截屏/电池/GPS/传感器）。快照仅体现为 Quick Boot 热启动，无独立快照导出命令。
【启示】list/create/start/stop/screenshot 均可脚本化，满足智能体"无头拉起-验证-回收"需求；`-license accept`、`-force` 已为非交互设计。

## 鸿蒙域能力检查清单
1. 用 API level（含 26.0.0 SemVer 新格式）做能力矩阵判定
2. hvigorw 无头构建（assembleHap/App/Hsp/Har + buildInfo 回读）
3. codelinter --fix + --exit-on 接入门禁
4. hdc 推包/取日志/端口转发（模拟器默认 127.0.0.1:5555）
5. Emulator CLI 全生命周期（create/start -noWindow/stop/screenshot）
6. hapsigntool 命令行签名（CI 流水线内）
7. hvigorw onDeviceTest/test + DevEcoTestingConsole 双层测试
8. module.json5/build-profile.json5 三件套 schema 校验
9. 对接 DevEco MCP 市场与自定义 Agent 规范（避免重复造轮子）
10. 仓颉 cjpm 作为可选构建后端（体验版，需降级预期）

来源：developer.huawei.com documentPortal（ide-hvigor-commandline、ide-commandline-emulator、ide-emulator-command-line、ide-command-line-codelinter、command-testing、ide-deveco-code-agent、ide-codegenie-releasenote、ide-agent-mcp、overview-2600、version-number-26、overview-600、hmaf-introduction、agent-overview 等）；gitee.com/openharmony/docs（release-notes、subsys-toolchain-hdc-guide、module-configuration-file）；cangjie-lang.cn（/download、/article/news、cjpm_usage_ohos-V5）。
