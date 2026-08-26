# hmharness 路线图

## Phase 0 — 行走骨架 ✅(2026-08-26 当日达成)
- [x] 四包单仓(kernel/evolution/domain-harmony/cli),零依赖内核
- [x] 智能体循环 E2E:模型(FreeRide 网关)→list_dir 工具→中文总结→会话+洞察落盘
- [x] 鸿蒙域两把真工具:harmony_devices(hdc 3.2.0d 实测)/harmony_toolchain_check(hvigorw/ohpm 全绿)
- [x] HMH_HOME 完全隔离;deny-first 命令护栏;typecheck 通过

## Phase 1 — 可日用 ✅(2026-08-27 完结)
- [x] MCP 客户端接入:零依赖手写 JSON-RPC 2.0,stdio + Streamable HTTP 双传输,
      远端工具投影为 mcp_<server>_<tool> 进注册表;非 trusted 服务器默认走审批(实测 stdio 全链路含中文往返)
- [x] 流式输出(SSE):增量文本 + reasoning 思考块分离展示;空闲守卫替代总超时;tool_calls 分片重组
- [x] 鸿蒙域扩充:harmony_build(hvigorw assembleHap)/harmony_install(hdc install,app install 回退)/
      harmony_launch(aa start,bundle 名自动从 AppScope/app.json5 解析)/harmony_logs(hilog -x+grep)/harmony_uninstall
- [x] 权限审批门禁:Tool.needsApproval 声明式标记 + 循环内 ask 门禁;TTY 弹 y/N,非 TTY 默认拒,--yes/approval:auto 放行;
      审批事件落会话审计;MCP 工具默认受门禁
- [x] 上下文压缩:transcript 超预算时按字符裁剪最老 tool 输出(保护 system/首条 user/尾部 8 条),确定性无模型调用
- [x] tsc 构建+bin:hmh(四包 dist 产物,npx hmh 实测可用;rewriteRelativeImportExtensions 保源内 .ts 导入)
- [x] 工程创建:harmony_project_create 脚手架(16 文件含 hvigorfile×2/obfuscation/生成 PNG 图标),
      真实 hvigor 构建实测通过(harmonyOS 6.1.1 SDK / hvigor 6.24.1,BUILD SUCCESSFUL 5.5s,产出 entry-default-unsigned.hap)
- 踩坑记录(已固化进代码):根 oh-package.json5 必须携带与 hvigor-config 相同的 modelVersion,否则报误导性的"结构需升级";
  独立运行 hvigorw 需注入 DEVECO_SDK_HOME;hap 产物在 entry/build/ 而非根 build/
- 注:~~harmony_install/launch 真机回路待设备在位补测~~ **2026-08-27 模拟器(127.0.0.1:5555)全回路实测通过:
  脚手架→构建→安装("install bundle successfully")→启动("start ability successfully",页面 pages.Index 加载)→
  日志(抓到脚手架埋点 A00000/hmh: EntryAbility onCreate)→卸载;顺手修了 bundleNameOf 误读模块名的 bug**

## Phase 2 — 自进化转起来(2026-08-27 完结)
- [x] 进化循环 hmh evolve:读洞察→元模型起草技能→bench A/B 基线/候选门禁(回归即拒)→晋升或回滚;
      进化日志 evolution/log.jsonl;循环只写 skills/ 与 memory/,碰不到配置与安全设置(实测一轮,模型正确返回"无需沉淀")
- [x] 技能晋升管线:skills/draft→active→archive 三态,promote 自动快照现任版本,rollback 可恢复(确定性实测通过)
- [x] 记忆检索:ASCII 词 + CJK 二元组打分,任务相关 top-k + 最新几条注入,替代全量尾部注入(ACE:只增不删)
- [x] 会话 --resume:hmh resume [前缀] 从 jsonl 重建消息历史(含 tool_call_id 顺序配对),REPL 连续对话记忆
- [x] bench 升级:expect 支持 && 多条件;tools: loop 用例走完整智能体回路;种子用例自动播种
- [x] 审计补全:工具执行结果(session.tool)此前未落盘,已接线
- [x] 保留集防背题(GDPevo 式):holdout: true 用例不进门禁,晋升后复验,回归即回滚清退
      (确定性门禁测试三条路径全过:训练回归拒/保留回归回滚/好技能晋升;修复无快照时晋升者残留 bug)
- [x] 进化定时化:hmh evolve --every=N [--cycles=N] 常驻循环,单轮失败不断链;skills --promote/--rollback/--unpromote 手工管理
- [x] runEvolution 预设提案参数(测试与未来 UI 直驱门禁)
- [x] TUI 前端:以极简版落地(hmh tui,见 Phase 3——状态头+斜杠命令+流式;全屏 alt-buffer 版主动放弃,Web 已覆盖该体验)

## Phase 3 — 产品化(进行中)
- [x] 多智能体/子代理 spawn_agent(提前完成):递归智能体循环,深度上限 2,子代理无 MCP、
      共享审批门禁,审计以 sub1> 前缀落同一会话(真实模型实测:父代理委派→子代理 list_dir→汇报总结)
- [x] Web 前端 v1(自研,零依赖):`hmh web` 起 node:http 本地服务(127.0.0.1),SSE 推流
      (思考/正文/工具/审批/终态),**审批门禁桥接浏览器**(批准/拒绝按钮,5 分钟超时安全拒),
      内嵌无构建单页应用(技能/洞察/进化/会话侧栏,会话回放);E2E 实测:远程批准 write_file→文件真实落盘
- [x] 旧线能力迁移评估(docs/MIGRATION-ASSESSMENT.md,34 工具逐项判定):旧线三种子技能
      (仓颉踩坑/cjpm 修复/hdc 手册)已全文导入新线技能库;hm-keeper 运维管家行为规格成文待重写;
      backlog:cjpm 工具、see_image、codelinter 包装、多模板脚手架
- [x] 架构分层定型:六包 kernel→evolution/domain-harmony→agent(执行层:工具/提示/spawn/runner)→cli/web(双前端)
- [x] 运维管家 v1(@hmh/domain-ops,生态雷达):多源拉取(gitee releases + github tags 双通道)→
      快照 diff → 模型中文简报(**网关不可达自动降级模板拼接**)→ 快照/简报/扫描日志落 HMH_HOME/ops/;
      单源失败不拖垮整轮(实测 oh-ets 404 被容错);`hmh ops scan|brief|status` + harmony_ops_* 工具三件套;
      真实 E2E:基线扫描四源全绿 → 二次扫描模型简报正确判"本期无变更"
- [x] 仓颉(cjpm)工具:harmony_cjpm_build/test(HM_CJPM 覆盖>PATH>已知安装根;仅对绝对路径推导
      CANGJIE_HOME,PATH 别名不注入——错误 CANGJIE_HOME 正是种子技能记录的头号坑);
      体检新增 cjpm 项;真实 E2E:cjpm init → harmony_cjpm_build → "build success"(cangjie 1.1.0)
- [x] 运维管家 v2:issue 流(@hmh/domain-ops/issues.ts,gh CLI 版)——list/view 只读,
      create/comment/PR 一律 needsApproval(**审批门禁即发布门禁**,替代旧线精确口令,机制上更严);
      发布内容自动附 hmh-keeper 署名;PR 恒为 draft+方案卡。
      E2E 实测(自家远程仓库):创建 #1 → 列表 → 评论 → 关闭 全通
- [x] see_image 视觉:内核 chatVision(多模态单图调用)+ see_image 工具 + config.vision 独立视觉提供商;
      实测(NVIDIA 网关 llama-3.2-90b-vision):真实浏览器截图问答,准确读出标题与侧栏板块
- [x] 国际化 i18n:config.locale(zh/en,默认 zh)——CLI 骨架字符串/审批文案、系统提示默认语言、
      Web 页面标签三处全量切换(agent/i18n.ts 双语字典,前端零构建)
- [x] codelinter 探测式包装 harmony_lint(PATH/DevEco/HM_CODELINTER 三级探测,未装给安装指引)
- [x] TUI 极简版 hmh tui:状态头(模型/语言/技能数/忙闲)+流式彩显+/tools /skills /ops /bench /status 斜杠命令;
      全屏 alt-buffer 主动放弃(Web 已覆盖该体验,零依赖不破)
- [x] 远程仓库:github.com/swsgbl/hmharness(私有)已建已推;仓库零密钥确认(git grep 扫描通过)
- 密钥处理:视觉密钥只写 HMH_HOME/config.json(隔离契约),仓库与代码零密钥

## 加固轮(2026-08-27 晚,五项边界全部落地)
- [x] **脚手架参数化 v2(彻底去 IDE 依赖)**:pages[]+modules[](feature HAP/har 库)一次调用生成任意结构
      (har 自动接线 entry 依赖,feature/har 分派 hvigor 任务);旧线"多模板"实为复制 DevEco 模板目录——
      它才依赖 IDE,hmharness 原生生成更彻底。E2E:确定性(3 页+feature+har→BUILD SUCCESSFUL)+
      **一句话**(真实模型 agnes-2.5-flash 自主参数化调用→BUILD SUCCESSFUL 5.37s)
- [x] **单元测试体系**:node:test 零依赖,20 用例覆盖 kernel(压缩/MCP stdio 全链路/会话重建)/
      evolution(技能三态/bench/记忆检索)/domain(参数化脚手架/PNG)/agent(i18n 键一致性);
      测试逮住并修复 McpClient 缺 spawn error 处理的真缺陷
- [x] **CI 流水线**:.github/workflows/ci.yml(push/PR→typecheck+test+build+编译版冒烟,ubuntu/node22)
- [x] **codelinter 端到端**:发现 DevEco 自带 plugins/codelinter/run/index.js CLI→接线(node 启动);
      官方 CLI 真实跑通一句话工程的检查;顺手修了绝对路径 join 缺陷
- [x] **视觉多提供商**:config.visionFallbacks[] 备用链(逐个降级尝试);agnes-2.5-flash 实测可作主模型
      (工具调用干脆)已切换为默认主模型;商汤未找到 base URL(旧线 yaml 为空)留待用户提供
- [ ] 物理设备真机回路(硬件阻塞:模拟器已全通,脚本 scripts/e2e-device.mts <target> 即绪)

## 模拟器自治轮(2026-08-27 深夜,零 GUI)
- [x] **模拟器管理五件套(无 DevEco GUI)**:发现 Emulator.exe 本身就是无头 CLI
      (`-hvd <名> -path <deployed> -imageRoot <镜像根>`),设备实例=lists.json 条目+两份 key=value INI
      (qcow2 覆盖层首启自建)——harmony_emulator_list/start/stop/create/delete 全程命令行;
      create 克隆现有硬件档+新 uuid(装新"类型"的镜像仍需一次组件管理器,已装镜像可无限开实例)
- [x] E2E:创建 HmhTest→无 GUI 启动(hdc 出现第二台 127.0.0.1:5557)→按名停→删除,全通;
      顺手修了 -hvd 带空格设备名的运行态误报
- [x] **一句话模拟器供给(真实模型实测)**:"创建叫 Demo 的模拟器并启动,报告设备数"→模型自主
      编排 list/create/start/devices,双 target 验证后正确汇报"2 台"
- [x] **全系机型目录 + 变体物化**:harmony_emulator_catalog 读取 DevEco productConfig.json
      (Phone 全系 Pura/nova/Mate/Enjoy/Pocket + Foldable/WideFold/TripleFold 完整档案);
      harmony_emulator_create 新增 model= 参数——任意机型屏幕规格即刻物化为可启动实例
      (E2E:ProTest 以 Pura 90 Pro 规格 1256x2760@560 创建成功)
- 诚实边界:**镜像级下载无公开通道**——华为模拟器系统镜像的下载绑定 DevEco 组件管理器+账号签名 URL,
      OpenHarmony 公开镜像(repo.huaweicloud.com/openharmony)只有真机 ROM 与 SDK、无模拟器镜像
      (CI 的 qemu 镜像质量/配套差距大,不接)。故"各种设备"=已装镜像的全机型变体自由开;
      新"类型"镜像(tablet/wearable)仍需一次 GUI 侧组件下载,此后又归 hmharness 全权管理

## 迁移策略(旧线→新线)
不迁移代码,迁移**知识与验证过的事实**:旧线 6 插件的行为规格、34 工具清单、鸿蒙工具链踩坑(memory 已沉淀)、运维流程门禁设计。旧线保持可用直到新线 Phase 2 末达到功能对齐,再议退役。

## 红线(每阶段不可破坏)
- 内核零依赖;新增依赖须论证且过评审
- 隔离契约(HMH_HOME/零密钥/deny-first)不放松
- 每次进化类变更必须 bench 绿后才算完成
