# hmharness 立项调研(2026-08-26)

## 一、智能体循环:2026 共识 = "Loop Engineering"
- 核心算法回归朴素:LLM↔工具调用的 while 循环 + 显式终止 + 上下文管理(LangChain/AWS/Oracle/Machine Learning Mastery 多源一致)
- Anthropic《Writing effective tools for AI agents》:简单循环胜过花哨编排
- 社区共识:"Boring architecture wins in production"
- 生产级五层观:循环之上是记忆/状态/沙箱/审计;沙箱-权限-审计为不可妥协项
- 采纳:内核=极简循环;审计(session jsonl)与 deny-first 从 Phase 0 就有

## 二、MCP 已成事实标准
- 月 SDK 下载 9700 万,服务器 5800+;2026-07-28 新规范走向 stateless/cacheable/routable;路线图含 agent identity
- 采纳:Phase 1 原生 MCP 客户端;工具生态借力,不重造

## 三、自进化:从 DGM 到"进化什么"
- DGM(2025,Sakana+UBC):自改代码智能体,档案库+进化搜索,证明开放式自我改进可行
- 2026 研究焦点转向进化对象:skill library、持久记忆、跨会话经验(Voyager 血统)
- 工程启示:自改进必须有适应度信号(bench)与档案(insights),否则=漂移
- 采纳:memory/skills/insights/bench 四件套为内核一等公民;进化循环 Phase 2 落地,bench 为门禁

## 四、运行时三强
- Node:稳定+生态兼容王(鸿蒙工具链 hvigor/ohpm 为 Node 系——决定性)
- Bun:冷启动最快,CLI 友好,但兼容风险
- Deno 2:安全+单文件编译,npm 兼容已齐
- 采纳:Node 22+TypeScript;tsx 开发;tsc 构建。留记:Bun 可作未来分发选项

## 五、反面教材(本项目立项动机)
旧线 harmony-harness 基于 DeepSeek Harness 做发行版的维护税实测:环境隔离四笔账、品牌 vendor-patch、peer 依赖闭包、上游 RC 通道破坏性变更——发行层的痛苦远超价值层。结论:全新框架必须**零运行时依赖内核+彻底隔离**,能力全部自持或经标准协议(MCP)外借。
