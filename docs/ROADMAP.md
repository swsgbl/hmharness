# hmharness 路线图

## Phase 0 — 行走骨架 ✅(2026-08-26 当日达成)
- [x] 四包单仓(kernel/evolution/domain-harmony/cli),零依赖内核
- [x] 智能体循环 E2E:模型(FreeRide 网关)→list_dir 工具→中文总结→会话+洞察落盘
- [x] 鸿蒙域两把真工具:harmony_devices(hdc 3.2.0d 实测)/harmony_toolchain_check(hvigorw/ohpm 全绿)
- [x] HMH_HOME 完全隔离;deny-first 命令护栏;typecheck 通过

## Phase 1 — 可日用(2026-08-27 完成主体)
- [x] MCP 客户端接入:零依赖手写 JSON-RPC 2.0,stdio + Streamable HTTP 双传输,
      远端工具投影为 mcp_<server>_<tool> 进注册表;非 trusted 服务器默认走审批(实测 stdio 全链路含中文往返)
- [x] 流式输出(SSE):增量文本 + reasoning 思考块分离展示;空闲守卫替代总超时;tool_calls 分片重组
- [x] 鸿蒙域扩充:harmony_build(hvigorw assembleHap)/harmony_install(hdc install,app install 回退)/
      harmony_launch(aa start,bundle 名自动从 AppScope/app.json5 解析)/harmony_logs(hilog -x+grep)/harmony_uninstall
- [x] 权限审批门禁:Tool.needsApproval 声明式标记 + 循环内 ask 门禁;TTY 弹 y/N,非 TTY 默认拒,--yes/approval:auto 放行;
      审批事件落会话审计;MCP 工具默认受门禁
- [x] 上下文压缩:transcript 超预算时按字符裁剪最老 tool 输出(保护 system/首条 user/尾部 8 条),确定性无模型调用
- [ ] tsc 构建+单包发布(bin:hmh)
- [ ] 工程创建(DevEco 模板命令行化,当前用 DevEco IDE 创建后交给本框架构建)
- 注:harmony_build/install/launch 的真机回路待有设备/模拟器在位时补实测(当前 hdc/工具链探测全绿)

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
