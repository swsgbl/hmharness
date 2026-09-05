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
- [x] TUI(初版:状态头+斜杠命令;后于 2026-08-28 重写为 Claude-Code 式全屏版:
      备用屏+整帧重绘+CJK 宽度、斜杠面板(↑↓ 选择/Tab 补全/Enter 执行)、
      SGR 鼠标滚轮翻页、审批卡、历史/翻页/块状光标;REPL 同步获得全套斜杠命令;
      2026-09-04 /model 选择器两段式(裸 /model+Enter 开面板,第二记 Enter 确认,
      Esc 关闭,滚轮驱动面板,i18n 提示行常驻——静态列表死路根除;二轮:SS3 方向键
      归一化+DECCKM 强制、面板模态鼠标上报+点击选中行、/lang 界面语言切换))

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

## 定位(差异化,对照厂商 IDE 内置智能体)

厂商 IDE 的内置闭环(需求→构建→推模拟器→自动验证)覆盖单人单仓场景;hmharness 的差异化在
**开放编排层**:任意厂商模型按用途路由、MCP 生态即插、跨仓库/批量任务、可嵌入 CI 的
无头运行(设备与模拟器全 CLI 化)、以及带防投毒筛选+双集门禁的可审计自进化——这些是
闭源内置智能体不提供的能力。文档与演示一律以此为叙事主线。

## 双前端对标轮 ✅ (2026-08-28)
- [x] Web 三栏布局(deepseek-harness 式:侧栏/对话/详情列);输入框 min-height:0 链修复
- [x] 侧栏导航:任务看板(insights 卡片,点击回放)/设备(hdc 探测)/技能中心(技能+洞察+进化日志)
- [x] 工作区实体(注册表 workspaces.json;切换=服务端 chdir+会话按 cwd 分组;
      目录选择器弹层:盘符/面包屑/文件夹浏览) 
- [x] 聊天打磨(用户右气泡/可折叠思考/代码块语言栏+复制/重新生成);i18n 全覆盖+--locale 旗标
- [x] 文档:README.en.md 英文版;中文 README 修复历史编码损坏并同步新功能

## 智能体内核成熟轮 ✅ (2026-09-02~03,基于用户运行实录三轮审计+架构质问)
- [x] 实战加固:系统提示词注入宿主事实(cmd.exe 身份+等价速查+探测优先+禁全盘扫
      +失败两次换策略);工具失败模式自动入长期记忆;write_file 覆盖 config 快照
- [x] 非标网关兼容:Bearer 401 自动重协商 X-Api-Key(freellmapi 实测);authHeader 显式字段
- [x] 工具层硬墙:Windows Unix 管道预检(给 cmd 等价)+重复失败第 3 次短路;DENY 精度
      (单文件 del 放行,递归删只拒盘根/系统目录/家目录);hmh skills add 安装器(三种布局)
- [x] Web 跨任务连续对话记忆(conversation 线程,内核压缩随任务跑,新会话 fresh 重置)
- [x] 原生 web_search(零 key,DuckDuckGo)+web_fetch(URL→可读文本)
- [x] 输出人本化:工具流折叠一行可展开,AI 回答为可见主体
- [x] 内核并行工具执行(审批串行保序+执行并发,计时单测;UI ⏏ parallel 分组框)
- [x] 三层即时反馈:Tier1 系统级错即记(阈值 2→1)/Tier2 每出错任务即时模型反思入记忆
      /Tier3 全进化轮阈值 8→3(autoEvolveEvery)——"越用越聪明"成为默认行为
- [x] 审批修复+YOLO:远程审批钩子只挂询问模式(此前覆盖 yes 标志的根因 bug);
      web 三档 ask/auto/yolo+CLI --yolo;状态行迁输入框上方带模式徽标
- [x] 桌面自动化三件套:desktop_screenshot(视觉链)+click+type,看→动→验闭环
- [x] 浏览器自动化:browser_open 可见浏览器+桌面三件套组合(Windows 无头输出全空,
      平台限制,诚实路线);web UI/官网 GSAP 动画(CDN 降级守卫)
- [x] 会话管理:重命名(titles 映射,审计 jsonl 不变)/归档/删除(trash 可恢复),悬停操作
- [x] SSH 一等能力:内核 ssh_run 工具(config sshHosts 密钥不出 HMH_HOME;
      只读探针含 && 链逐段白名单免审,写/重启类审批门禁)+Web SSH 视图(第五导航项:
      主机卡+命令输入+终端面板+批准并运行流,POST /api/ssh 代理);ndtool 服务器实测
- [x] i18n 守门:页面 L.引用 vs zh/en 双字典分别校验;TUI COMMANDS vs i18n 对称检查

## 代码级自进化轮 ✅ (2026-09-03,DGM 桥)
- [x] 进化循环从提示词层升级到代码层:proposePatches(元模型看信号+热工具源码,
      提 find/replace 补丁)/isPatchableFile 硬守卫(永禁 kernel loop/provider/
      config/security——自举悖论防护)/沙箱 git 分支/沙箱内全链 build+双样本 bench/
      过门合并/回归即回滚(checkout main+删分支零残留)
- [x] 端到端验证(285439e):补丁先在分支上提交再 bench(修"未提交改动漂移 main"真 bug);
      临时仓跑完整周期,merge 路径+revert 路径+树净全部实证
- [x] 红线更新(CONTRIBUTING):进化写 skills/+memory/+可提代码补丁(限 src/沙箱/
      门禁/回滚四条件同时满足)

## 待办(非阻塞)
- [x] **自进化生产化 P0+P1(2026-09-04,论文验证驱动)**:血缘账本(lineage+
      skillsInjected)/金丝雀晋升(canary 态+20% 采样+水印+`bench --impact`
      对照组判定)/进化预算闸门/技能算子 pin/decay(dormant 不删)/GEPA
      Pareto 池+单祖先变异+Merge 交叉(忠实原文机制)/AWM 工作流归纳(走
      既有门禁管线);12 篇论文原文验证修正三处转述失真,详见
      docs/research/self-evolution-upgrade.md 与 DEVLOG 当日轮
- [x] **P2 推理时进化(2026-09-04)**:高代价命令预检(commandPreflight,
      hvigorw/hdc/ohpm 相对脚本毫秒级验存在)/CRITIC 结构化反思(run_command
      第 2 次失败追加 LOCATE+HYPOTHESIZE 诊断要求,第 3 次短路)/静态知识
      刷新(knowledge.ts:release-notes 快照 diff→知识补丁草案→既有门禁
      管线,离线 no-op)
- [x] **P3 拓扑最小版(2026-09-04)**:spawn_agent 角色参数+ok 率记录
      (spawn-roles.jsonl)+≥3 样本排行榜注入下次委派——模型自学会
      不派任务给垫底角色(诚实最小实现,无 MARL)
- [x] **设备回路打通(2026-09-05,模拟器)**:用户指出模拟器即够——hdc 通道
      不区分模拟器/真机;e2e-device.mts 全链一次过:scaffold→schema_check→
      build→install→launch→**logs 回读 EntryAbility onCreate**(应用真在
      模拟器上运行)→uninstall,零人工介入;脚本归档可重复跑
      (真机到位时同脚本直用)
- [x] **编译-修复闭环+项目画像(2026-09-05,旧线 icf+quality 基座)**:
      harmony_build_doctor(失败日志七类签名分类+每类具体修复+首错块提取,
      未知签名不隐藏)、harmony_project_profile(模块/页面/依赖/资源/配置
      健康一次调用出全像);api_kg/channel/cybernetics 维持排期
- [x] **hapsigntool 签名封装+onDeviceTest(2026-09-05,设备实证)**:
      harmony_sign(全自动 SDK 调试签名:自动刷新过期模板生成 profile+
      实证别名/证书链组合;破案五关见 DEVLOG 当日轮)与 harmony_device_test
      (install→launch→hilog 生命周期标记断言→cleanup 四步判定)——签名
      后的 hap 在模拟器真实安装/启动/打出日志,最终验收全自动化四步全 PASS
- [ ] npm 公开发布 bin(README 用法以 npm link 为准,发布后更新)
      【排期:发版前需 README/CI npm provenance 检查】
- [x] **进化循环接入雷达信号源(2026-09-04)**:evolution/radar.ts 只读消费
      ops 保管员最新生态简报(≤14 天新鲜度+1200 字截断),signals.ecosystemNews
      喂提议提示词("顾及近期发布,别给过时工具链建议")——只读不触发,
      预算边界不破(视觉用于 UI 回归基准仍待做)
- [ ] 新设备类型镜像的自动下载(依赖厂商开放公开通道)【blocked:厂商】
- [x] **域缺口:API 能力矩阵+schema 校验(2026-09-05)**:apimatrix.ts 双形态
      版本解析("6.1.1(24)" 遗留 vs 26+ 纯 SemVer,major=API level,改版适配
      单点收敛)+compareSdk+能力矩阵;scaffold 入口预检 HM_SDK_VERSION(坏值
      即报期望格式);schema.ts 宽松 JSON5+module.json5/build-profile 结构校验
      +harmony_schema_check 工具(构建前毫秒级精确字段报告;e2e 冒烟钉死:
      真 scaffold→过→损坏→精确捕获)。仍缺:hapsigntool 签名封装、
      onDeviceTest 设备测试
- [x] **门禁方法学(2026-09-04)**:bench 断言升级四模式(expect-exact 精确
      等值/expect-regex 正则/expect-none 禁词否决/expect-any 多选一,旧
      expect 子串语义向后兼容)+成本双指标门(候选输出成本超基线×cap 拒绝,
      默认 1.3x,用例 cost-cap 行自定义)+坏正则判例错误;评测集滚动窗口
      与候选多样本重测此前已备(双样本门)
- [x] **旧线域缺口收官(2026-09-05~09-04)**:
      api_kg✅ apikg.ts(927 个 d.ts 索引为 20,241 符号/0.2s,声明片段+
      file:line 证据+kit 归属;harmony_api_lookup 拦截 API 幻觉,假符号
      诚实拒)、icf✅ harmony_build_doctor(七类失败签名分类+修复建议)、
      quality 基座✅ harmony_project_profile(模块/页面/依赖/资源/配置
      健康全像)、channel✅ ops_notify(飞书 HMAC 签名/钉钉签名 URL/通用
      JSON webhook,配置驻 HMH_HOME,审批门);cybernetics 维持实验排期;
      视觉回归(quality 其二)待视觉模型配合
      可搬数据资产已归档:38 厂商路由模板/营销物料/实战记忆(insights 已并入
      HMH_HOME 长期记忆)存 ~/.hmharness/local-docs/harmony-harness-archive/

注:外部审核报告(2026-08-27)与旧线迁移评估为私有文档,存 HMH_HOME/local-docs/,
不入库(仓库公众化红线)。
