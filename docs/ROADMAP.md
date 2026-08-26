# hmharness 路线图

## Phase 0 — 行走骨架 ✅(2026-08-26 当日达成)
- [x] 四包单仓(kernel/evolution/domain-harmony/cli),零依赖内核
- [x] 智能体循环 E2E:模型(FreeRide 网关)→list_dir 工具→中文总结→会话+洞察落盘
- [x] 鸿蒙域两把真工具:harmony_devices(hdc 3.2.0d 实测)/harmony_toolchain_check(hvigorw/ohpm 全绿)
- [x] HMH_HOME 完全隔离;deny-first 命令护栏;typecheck 通过

## Phase 1 — 可日用(目标:2 周)
- [ ] MCP 客户端接入(stdio+HTTP,工具投影到注册表)
- [ ] 流式输出(SSE)与思考块展示
- [ ] 鸿蒙域扩充:工程创建(模板)/hvigor 构建/安装运行(hdc install+shell aa)/日志抓取
- [ ] 权限与审批门禁(写操作/设备操作须确认,配置化)
- [ ] 上下文压缩(长会话 token 预算)
- [ ] tsc 构建+单包发布(bin:hmh)

## Phase 2 — 自进化转起来(目标:+4 周)
- [ ] 进化循环:定期任务读 insights→起草技能/提示改进→bench 回归→晋升/回滚
- [ ] 记忆检索(向量或关键词索引,替代全量注入)
- [ ] 技能晋升管线:draft→tested→promoted 三态
- [ ] 会话 --resume 与压缩快照
- [ ] TUI 前端(第一版:极简,参考行业 ink 系)

## Phase 3 — 产品化(目标:+8 周)
- [ ] Web 前端(自研,不复用任何上游 UI)
- [ ] 多智能体/子代理 spawn(fork 模式)
- [ ] 运维管家移植(雷达/issue 流,复用旧线经验)
- [ ] 旧线 harmony-harness 的能力迁移评估(逐项:重写 or 复用其 TS 源)

## 迁移策略(旧线→新线)
不迁移代码,迁移**知识与验证过的事实**:旧线 6 插件的行为规格、34 工具清单、鸿蒙工具链踩坑(memory 已沉淀)、运维流程门禁设计。旧线保持可用直到新线 Phase 2 末达到功能对齐,再议退役。

## 红线(每阶段不可破坏)
- 内核零依赖;新增依赖须论证且过评审
- 隔离契约(HMH_HOME/零密钥/deny-first)不放松
- 每次进化类变更必须 bench 绿后才算完成
