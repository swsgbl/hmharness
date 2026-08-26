# hmharness 路线图

## Phase 0 — 行走骨架 ✅
- [x] 四包单仓,零依赖内核;智能体循环 E2E(模型→工具→总结→会话+洞察落盘)
- [x] 鸿蒙域首发工具(设备列表/工具链体检);HMH_HOME 隔离;deny-first 护栏;typecheck 绿

## Phase 1 — 可日用 ✅
- [x] MCP 客户端(手写 JSON-RPC 2.0,stdio+Streamable HTTP,远端工具投影;非 trusted 默认走审批)
- [x] 流式输出(SSE,思考块与正文分离,tool_calls 分片重组,空闲守卫)
- [x] 鸿蒙域全生命周期(构建/安装/启动/日志/卸载,设备写操作受门禁)
- [x] 权限审批门禁(声明式 needsApproval + 循环统一执行点;TTY 弹窗/非交互拒/--yes 放行;审批落审计)
- [x] 上下文压缩(确定性字符预算,保护 system/任务/尾部)
- [x] tsc 构建 + bin:hmh;工程脚手架(hvigor 真实构建验证)

## Phase 2 — 自进化 ✅
- [x] 进化循环(洞察→起草→训练集 A/B 门禁→晋升/回滚;进化日志;只写 skills/+memory/)
- [x] 技能三态管线 draft→active→archive(晋升快照+回滚);记忆检索(关键词/CJK 二元组,只增不删)
- [x] 会话 resume;bench 升级(&& 多条件、回路模式、自动播种)
- [x] 保留集防背题(晋升后复验,回归回滚清退);进化定时化 --every;技能管理命令
- [x] TUI(极简版:状态头+斜杠命令;全屏版主动放弃,Web 已覆盖)

## Phase 3 — 产品化 ✅
- [x] 多智能体 spawn_agent(递归循环,深度上限,共享审批,审计前缀)
- [x] Web 前端(零依赖 node:http+SSE;浏览器远程审批;会话回放;i18n)
- [x] 旧有能力迁移评估(私有文档,结论:行为规格迁移、代码零搬运;三枚种子技能入库)
- [x] 运维管家:生态雷达 v1(多源拉取/快照 diff/模型简报+模板降级/单源容错)
      + issue 流 v2(gh CLI,AI 只起草+审批门禁即发布门禁+draft PR+身份署名)
- [x] 仓颉 cjpm 构建/测试;视觉 see_image(多提供商降级链);国际化 zh/en;
      codelinter 接线(官方 CLI);远程仓库+CI

## 加固轮 ✅
- [x] 参数化脚手架 v2(pages+modules:feature HAP/har 库,一句话建任意结构,双 E2E 含真实模型编排)
- [x] 单元测试(node:test 零依赖,覆盖 kernel/evolution/domain/agent;逮住并修复 McpClient spawn error 缺陷)
- [x] CI(GitHub Actions:typecheck+test+build+编译版冒烟)
- [x] 主模型多厂商路由(providers+routing 按用途分派,向后兼容单 provider 配置)

## 模拟器自治轮 ✅
- [x] 无 GUI 模拟器管理(发现官方 Emulator.exe 即无头 CLI;实例=清单+INI 配置)
      harmony_emulator_list/catalog/start/stop/create/delete 全生命周期
- [x] 全系机型目录 + 变体物化(model= 参数,任意机型屏幕规格即刻部署)
- [x] 一句话模拟器供给(真实模型自主编排 create+start+devices,实测通过)
- 边界:模拟器系统镜像下载绑定厂商账号(签名 URL,无公开通道);开源鸿蒙公开镜像仅含
      真机 ROM/SDK 无模拟器镜像。已装镜像的设备类型可无限制开实例与机型变体。

## 待办(非阻塞)
- [ ] 物理真机回路(等设备接入;scripts/e2e-device.mts 一键即绪)
- [ ] npm 公开发布 bin
- [ ] 进化循环接入雷达/issue 信号源;视觉用于 UI 回归基准
- [ ] 新设备类型镜像的自动下载(依赖厂商开放公开通道)
