## [0.9.0] - 2026-09-13

**V2 蓝图 P1/P3 收官(M10+M11)**——Trajectory Dataset + Shadow Router + RL 前置门
(ADR-0004/0005)。至此蓝图 M0-M11 全部闭合:

- **M10a Dataset 管线(evolution/dataset.ts)**:runs/ 轨迹 → filter(兼容 M1
  recorder 嵌套 schema 与扁平形态)→ dedupe(task+outcome+turns+tools 指纹,
  重复失败轮只留一条)→ label → reward(**可解释映射**:ok 从 1.0 起每 10% 工具
  失败率扣 0.1(扣减封顶 0.6),非 ok 封顶 0.3,llmJudge 证据等级 ≥5 永不超
  0.7——与 M2 硬顶一致)→ 版本化落盘(manifest 含扫描窗口/过滤指纹/切分种子/
  reward 直方图)→ 确定性 8:2 train/eval 切分。**导出即脱敏**(redactSecrets
  全量过一遍,evidence 页教训)。CLI:`hmh dataset build|list|show`。真机:
  43 轨迹 → 19 样本(15/4)。
- **M10b Shadow Model Router(kernel/router.ts)**:extractFeatures(complexity
  启发式/语言/domain/expectedContext)+routeDecision 纯函数**建议**——不改
  变现有静态路由;runner 每次 run 记录 routing.outcome(任务特征+实际路由+
  建议路由+运行结果回填)到 evolution/routing.jsonl。**影子先行,门禁切换**
  (与 M9 同纪律:统计显著前建议不接流)。CLI:`hmh route`。
- **M11 RL 前置门(evolution/readiness.ts)**:六条件从真实磁盘证据逐条测量
  (≥1000 高质量轨迹/≥100 bench 任务/reward-人工相关性标注/评估回归套件
  稳定/版本可追溯/offline eval+holdout),任何条件不满足即 **optimize-first**
  并点名应做的优化杠杆(data-collection/bench-expansion/reward-calibration/
  eval-suite-stabilization)。**无任何强制进入 RL 的开关**——蓝图红线无绕行。
  CLI:`hmh readiness`。真机:20/1000 轨迹 → optimize-first(data-collection)。
- 测试 +11(dataset 4:reward 映射/确定性切分/过滤去重/脱敏导出;router 3:
  特征提取/建议纯函数/记录统计 n≥8 地板;readiness 3:空仓/全满足/回归阻塞;
  redact 1)。全套 211+2 绿。
- SELFFEED 第 12 天:SelfFeed1 设备端到端(模拟器 install/launch/响应验证)。

## [0.8.4] - 2026-09-13

**V2 蓝图 P1 第二批(M8+M9)**——Project Runtime + Evolution 泛化(ADR-0002/0003 先行):

- **M8 Project Runtime(agent/project.ts)**:Project 实体(状态机 created→active→
  paused→completed→archived,白名单校验)+ 检查点 + 决策日志 + 运行续接 + 发布钉住。
  **检查点=git plumbing 快照**:临时索引(GIT_INDEX_FILE)+read-tree+add -A+
  write-tree,对象落 .git/objects,**用户的索引/引用/分支/工作树零接触**(无需
  commit 即可打点;真机冒烟:hmharness 脏树 191 文件快照,前后 git status 逐字节
  相同);非 git 工作区降级目录拷贝。**恢复=物化沙箱副本**(git archive+tar 到
  sandbox 会话),代码里不存在任何能重置用户工作区的路径。运行续接复用 0.8.2
  rollout append(attachRun/resumeBundle);interrupt=记录+置 paused。CLI:
  `hmh project status|checkpoint|restore|pause|resume|complete|archive|release`。
- **M9 Evolution V2 泛化(evolution/candidates.ts)**:七类候选
  (prompt/skill/context/tool_policy/model_router/workflow/harness)注册表
  (注册即毒检)+ Control/Treatment 双臂实验 runner(ArmRunner 注入式,holdout
  排除)+ 双比例双侧 z 检验(A&S 26.2.17 CDF;每臂<8 needs-data,p<0.05 且
  diff≥+10% 才 promote-eligible,显著负向 reject——与 impact.ts 口径一致)+
  **带门禁的晋升状态机**:无 promote-eligible 报告不晋升、激活前必写 previous
  指针、agent 来源的 prompt/harness 候选需 `--human` 显式人工标记(生产提示词
  不可被生产代理自改)、skill 目标仍走 promoteSkill 金丝雀通道。CLI:
  `hmh experiment list|show|run|promote|rollback`。诚实边界:context/router
  等目标的运行时注入点属 M10,active 登记簿先行。
- ADR-0002/0003 落 docs/adr/;agent 新增 @hmharness/sandbox 依赖(M8 物化)。
- 测试 +10(candidates 5:统计/注册毒检/实验/晋升门禁/回滚;project 5:生命
  周期/find-or-create/git 快照零接触+物化字节比对/拷贝降级/运行续接+release)。
- SELFFEED 第 11 天:SelfFeed1 双构建对比(增量缓存行为诊断:第二次构建
  CompileArkTS/PackageHap 全 UP-TO-DATE,.hap hash 不变;剩余 ~1.2s 是 hvigor
  固定会话成本;4 个任务因声明输出不存在每轮重跑)。evolve 被预算门第 4 次
  生产拦截(5/4,如实留痕,不绕过)。
- **安全修复(insights 密钥脱敏)**:GitHub Push Protection(GH013)拦截发现
  审计数据里有真实 API key——用户把密钥打进任务文本("新增 provider sk-…"),
  recordInsight 原样入库且 evidence 页公开发布。修=evolution/insights.ts 新增
  redactSecrets(sk-/ark-/ghp_/npm_ 四形态),写入路径强制脱敏+存量两处
  (HMH_HOME/insights.jsonl、evidence raw)原位清洗;**已泄露到聊天记录的
  tokenrouter/火山方舟密钥建议用户自行撤换**。

## [0.8.2] - 2026-09-13

- **会话恢复照搬 openai/codex 重设计**(用户指令"直接照搬开源框架 codex 的
  恢复历史会话实现方式",源码调研 openai/codex codex-rs/rollout + tui/resume_picker):
  - **rollout 存储(kernel/session.ts)**:新会话落
    `sessions/YYYY/MM/DD/<id>.jsonl`(codex precompute_new_rollout_path),
    首行 session_meta 带 git 分支(纯 fs 读 .git/HEAD,零依赖红线不破)与
    forkedFrom;旧平铺布局继续可列可恢复(codex legacy rollout 同等待遇)。
  - **Resume=append 语义**:`Session.resume()` 打开同一 rollout 追加而非
    每任务新建文件(codex RolloutRecorderParams::Resume);REPL/TUI/Web 的
    整段对话写同一个文件,`runAgentTask` 新增 sessionId 续写;/clear 开新
    线程;撕裂行尾守卫(codex ensure_rollout_is_newline_terminated)。
  - **listSessions**(codex get_threads 移植):MAX_SCAN_FILES=10000、
    25/页锚点游标分页(新文件中途出现不重页)、updated/created 双排序、
    cwd 过滤、64KB 单读头提取标题+meta(codex HEAD_RECORD_LIMIT 思路)。
  - **Codex 式选择器(cli/resume-picker.ts + TUI 全屏 modal)**:typeahead
    小写子串过滤(标题/id/目录/分支,Row::matches_query)、Filter[Cwd|All]×
    Sort[Updated|Created] 工具栏(Tab 循环焦点,←→ 切值即重载)、❯ 选中标记
    +反色高亮、底部两行快捷键+`pos/total·pct%` 进度、距底 5 行预取下一页
    (LOAD_NEAR_THRESHOLD)、查询无本地命中继续翻页搜索(SearchState::Active)、
    过期分页响应用 token 丢弃(request_token)。
  - **入口全覆盖**:bare `hmh resume`(TTY)= 启动即开选择器(codex
    `codex resume`)、`hmh resume --last` = 当前目录最新(codex --last)、
    `/resume` TUI modal、`/resume <prefix>` 直载、Web /api/sessions 改走
    kernel listSessions(+nextCursor/branch/createdAt 字段)。
- **M5 完成生产接线**:retrieveMemory 的最终选择现在由蓝图权重 ContextRanker
  驱动(旧打分→relevance,时间→recency,distilled→importance 0.8,cost=chars/4),
  RANK_WEIGHTS 从库+测试变成真实检索路径(memory 7/7 回归绿)。
- **SELFFEED 第 10 天**:工具链健康检查发现 **Windows 更新 KB5124114/KB5124108
  弄坏仓颉(cjpm)工具链**(hdc/hvigorw/ohpm 不受影响);完整基线快照+两条教训
  固化进记忆(轨迹只存 120 字符 preview,完整输出须当场固化;%ERRORLEVEL% 对
  崩溃进程撒谎,真实退出码要用 Start-Process -PassThru)。
- 测试 189+2 全绿(+13:kernel rollout/列表分页 5、picker 状态机 9、TUI modal
  2,更新旧 palette 断言 2);typecheck 净。
- evolution 以 **0.8.3** 上架(0.8.2 在一次被中断的发布里已带旧 kernel 依赖
  占位,0.8.3 仅修正依赖钉到 kernel 0.8.2,代码与 0.8.2 相同)。

## [0.8.1] - 2026-09-12

V2 P1 第一批(M5+M7 切片)+SELFFEED 第 9 天:

- **M5 ContextRanker(evolution/ranker.ts)**:蓝图固定权重
  (relevance .30/dependency .20/recency .15/importance .15/similarity .10/
  tokenCost -.10)导出为单一常量供 Evolution 后续优化;rankContext 成本按批
  归一+平手便宜优先;packContext 贪心装填 token 预算;classifyMemory 四类
  记忆(episodic/semantic/procedural/project)按条目形态分类。
- **M7 Agent Team 角色契约(agent/roles.ts)**:六个规范角色
  planner/coder/tester/reviewer/judge/repairer 各带职责契约(判定角色契约
  内嵌 M2 证据优先级:只认证据、自报不算、VERDICT 结尾);spawn_agent 的
  role 参数命中规范名时注入契约到子代理系统提示词,自由标签行为不变;
  角色成功率排行榜(已有)继续积累。
- **SELFFEED 第 9 天**:破坏 module.json5→harmony_schema_check **精确点名
  module.mainElement**(文件::路径+修复语义),恢复字段后复检转绿(闭环);
  预算门第二次拦截(5/4,如实留痕);状态备份完成。
- 测试 +5(ranker 3/roles 2),全套全绿。

## [0.8.0] - 2026-09-12

**V2 蓝图 P0 第二批(M2+M3+M4+M6)**——Evaluation/Sandbox/Capability/HarmonyBench:

- **新包 @hmharness/evaluation(M2)**:Evaluator 契约+证据阶梯(build=1…llmJudge=7,
  self-report=8);三评测器(text-assertion 五模式/command-exit execFile 硬证据/
  llm-judge **分数硬顶 0.7**——裁判单独通过永远不算满分);evaluateRun 从
  **轨迹记录**(outcome/工具完成率/错误观测)判定并把 judge.completed 回写
  进可审计记录;runBenchCase 让进化门与评测共享同一断言核心。
- **新包 @hmharness/sandbox(M3)**:隔离工作区(git 快照/恢复字节级/diff/
  destroy)+ 三权限层(READ_ONLY 拒执行拒写/WORKSPACE_WRITE/FULL_ACCESS);
  execFile 无 shell 字符串(shellgate 教义);恢复=reset --hard+clean 仅在
  沙箱仓库内(ADR-0001 边界)。
- **Capability 清单层(M4,agent/capability.ts)**:全部注册工具投影为
  manifest(id/risk/permissions/requiresApproval/network/sideEffects)+
  PolicyEngine(lockdown 拒绝一切 host/device/process 触达;revoke 覆盖一切
  模式)。声明层叠加在现有执法层(needsApproval/shellgate/DENY)之上。
- **HarmonyBench 3→26 案例(M6 第一批)**:scripts/bench-cases-v2.cjs 安装
  23 个离线可验证案例(确定性金丝雀/工具知识/领域知识/结构化输出纪律),
  全部 holdout——进化门预算不膨胀,构成晋升后复验语料。
- **新 CLI**:hmh eval(评测器面+案例统计)、hmh capability(清单面,--lockdown
  预览锁定模式判定)。
- **SELFFEED 第 8 天**:codelinter 诚实 0 缺陷;**预算门首次生产触发**
  (5/4 轮超限,当日循环如实跳过留痕)。
- 测试:evaluation 5/sandbox 4/capability 2 全绿。

# 更新日志(CHANGELOG)

发布范围:npm org [@hmharness](https://www.npmjs.com/org/hmharness)(`@hmh` scope 已被他人占用,
故以 @hmharness 发布——与仓库名一致)。八包有序依赖:kernel → evolution → domain-harmony
→ domain-ops → agent → web → cli → codexhost-bridge(用户的开源适配器,独立发版节奏)。

## [0.7.0] - 2026-09-12

**V2 蓝图第一阶段(M0+M1)——Trajectory 飞行记录仪**(依据 V2/V3 路线图与施工方案,
外部主张已经全网核实:MCP 2026-07-28 无状态核心/Tasks、OpenAI Agents SDK
Runtime-Sandbox 分离、Zed ACP、Microsoft Agent Lightning):

- **新包 @hmharness/observability(零依赖)**:类型化 RunEvent schema v1
  (22 种事件:run/context/model/tool/error/repair/judge/checkpoint 族)+
  append-only JSONL TrajectoryStore(`HMH_HOME/runs/<run-id>/trajectory.jsonl`
  + summary.json)+ TrajectoryRecorder(best-effort:存储故障永不杀任务,
  串行队列防 JSONL 行交错)。载荷只含摘要(截断的工具名/参数/结果状态),
  密钥永不进 trajectory(ADR-0001 规则 3)。
- **runner 自动接线**:每个任务自动留完整轨迹——run.created/started →
  context.assembled(system 提示词成本)→ model.responded(每轮)→
  tool.requested/approved/denied/completed → error.observed →
  run.completed/failed(带 turns/tools/tokens/outcome)。无需调用方改动。
- **`hmh replay [run-id]`**:裸命令列最近 20 个 run(✓/✗/… + 任务 + 轮次);
  带 id 渲染事件时间线(+偏移ms/图标/类型/载荷);`--json` 导出原始轨迹。
- **kernel LoopResult 增加 `reason`**(final/idle/turn-valve/token-valve/
  interrupted)——Trajectory outcome 的数据源,UI 也可用。
- **M0 工件**:`docs/adr/ADR-0001-runtime-boundaries.md`(Runtime/Capability/
  Sandbox/Observability 四层所有权,采纳已验证的 Agents SDK 分离原则)+
  `docs/architecture/inventory.md`(现有资产盘点:蓝图里被低估的部分——技能
  五态/canary A/B/deny-first/审批分级均已在 0.6.8 存在;真实缺口=M1 Trajectory
  ←本次、M2 Evaluator、M3 Sandbox、M4 Capability、M6 HarmonyBench 规模化)。
  基线 tag `v2-foundation-baseline` 指向 0.6.8。
- 发布链九包:kernel → **observability** → evolution → …;测试 155→160
  (+4 store/recorder/schema +1 runner 接线:provider 失败仍留完整轨迹)。

## [0.6.8] - 2026-09-11

运行时稳定性修复(用户实测日志驱动:反复 `TypeError: terminated`,任务中断、只能
手打"继续"):

- **`TypeError: terminated` 归入可重试(核心)**:这是 undici 在 socket 被中途
  掐断时的报错(网关切长流/代理重置/服务重启)——旧重试正则
  (`abort|fetch failed|ECONN|...`)不含它,于是被当"永久错误"直接抛出,**任务
  当场死亡**。现在 transient 分类覆盖 `terminated|other side closed|
  premature close|UND_ERR|EPIPE|no response body` 等,断流自动重试。
- **重试前发 reset 信号,半截输出不再重复**:断流时已有部分文字上屏,直接重试
  会出现"半句话 + 完整答案"两份。新增 `DeltaKind 'reset'`:内核在重试前通
  知前端丢弃本轮流式块——TUI 的流追加器带 `drop()` 移除该 entry,Web 的
  say/think 块带 `discard()` 移除 DOM 节点。测试验证 deltas 序列为
  `[text 半句, reset, text 完整答案]`。
- **错误信息可读化**:不再抛裸 undici 错,改为
  `provider: failed after N attempts (url): ... - 连接被中途切断(网关丢弃长流
  或代理重置)` / `- 提供商停止发送数据(空闲超时)` / `- 端点不可达(网络/DNS)`。
- **consumeStream 清理修复**:空闲守卫胜出时 `reader.read()` 仍挂起,
  `releaseLock()` 会抛 "Cannot release a readable stream reader..." **掩盖真
  实错误**;改为先 `reader.cancel()` 再释放,并对空 body 明确报错(原先
  `res.body!` 非空断言会在网关异常时空指针)。
- **MCP 传输失败可读化 + 重试一次**:死掉/重启中的 MCP 服务器原先把裸
  `TypeError: fetch failed` 直接当工具结果返回给模型;现在重试一次并注明
  "MCP server 不可达或连接被切断"。
- **附带真实 bug(MCP 审计日志竞态)**:`mcp-server.ts` 未知工具分支
  `void logCall(...)` 不等待就回响应,导致 `insights/mcp-calls.jsonl` 的拒绝
  记录**时有时无**(实测 8 次跑 2 次缺失)。审计日志必须"先落盘再可见",
  改为 log-then-reply。修后 8/8 稳定。
- **重试策略可配置**:`ChatOptions.retry{attempts,baseMs}`(默认 6 次/3s 指数
  退避),供调用方与测试使用。
- 测试:+4 断流韧性(本地假服务器模拟 socket destroy → 断言重试与 reset 顺序)、
  不可达端点报错可读性、非流式回归。

## [0.6.7] - 2026-09-11

外部审核(全部指控经可执行复现核实)+ 全网方案调研(Codex 三层沙箱模型、
CVE 已登记的 allowlist 绕过手法、DGM/AlphaEvolve 安全共识、MDN Retry-After
规范)后的安全与诚实修复批次:

- **死代码工具注册(审核 Critical #1)**:web_search/web_fetch/browser_open/
  desktop_screenshot/click/type/ssh_run 定义了但从未进 baseTools——README
  宣称的"网络原生+桌面自动化"运行时不存在。全部注册,宣称成真。
- **edit_file 审批分级(审核 Critical #2,采 Codex workspace-write 模型)**:
  工作区内免审批;**HMH_HOME 永远审批**(config.json 能改写审批策略本身,
  无门=一枪拆掉整个审批体系);工作区外审批;无 ctx 时失败关闭。kernel
  的 needsApproval 签名加可选 ctx 参数。
- **代码级自进化默认关闭(审核 Critical #3,采 DGM 论文"unsafe by default"
  共识)**:`evolution.autoPatch=true` 显式开启才运行补丁循环;**拒绝在脏
  工作树上运行**(旧版 git stash 吞掉用户未提交工作且从不 pop);revert
  路径不再 `reset --hard`(main 上的硬重置正是毁工作的操作);修
  harmony_devices→devices.ts 幽灵映射(该文件不存在,工具从未被提议)。
- **SSH 门禁重写(kernel 新增 shellgate,双端共用)**:裸探测快速通道=
  白名单动词+纯参数+**零 shell 元字符**;`find -delete`/`echo $(touch)`/
  `>&`/`date -s` 等已登记绕过类(GHSA-cv3g-hj65-pcfh 等)全部阻断;修
  TUI ssh_run 正则空分支死代码(`|>||` 匹配一切→所有探测都弹卡)。
- **Retry-After 规范解析(MDN)**:只认 delta-seconds/HTTP-date 两种合法
  格式,clamp ≤120s;**不再读 x-ratelimit-reset**(野外是 epoch 时间戳,
  旧解析得 1.7e12ms 溢出 setTimeout→立即重试风暴)。
- **token 阀 usage 兜底**:不报 usage 的网关上 50M 阀原先恒计 0(失控循环
  无停点)——现按 chars/4 本地估算计入。
- **matchesRule 全段 `..` 阻断**:边界检查漏掉
  `node scripts/sub/../../evil.js`(首个差异段不是 ..)。
- **诚实三修**:证据页 bench 用例计数 `.task`(原先 .txt/.json 恒显示 0,
  违反导出器自己的"不静默零填充"规则);SELFFEED 预算键双拼写兼容
  (cyclesPerDay 文档键原先完全不生效)且 token 上限真正执行(按日累计
  estTokens 门);publish-preflight 挂 typecheck+单测(原先只查构建新鲜
  度,"能编译"≠"能发布")。
- 测试:shellgate 14 条载荷(全部审核绕过手法)、edit_file 分级 5 断言、
  matchesRule 嵌套穿越、Retry-After 解析。

## [0.6.6] - 2026-09-11

- **Codex 桌面版式极简交互(cli/tui.ts + web)**:发送/停止合一,队列全可视化,
  移除特殊语法:
  - **Web**:发送按钮三态——空闲+空输入=「运行」;有文字=「发送」(运行中发送
    自动排队);**运行中+空输入=红色「⏹ 停止」**(点击打断当前任务,排队任务
    继续)。输入框上方新增**队列栏**:每个排队任务一行(序号+文本+✕ 单独移除),
    底部「清空队列」,SSE 实时刷新,页面中途刷新也能恢复队列与运行状态;
  - **TUI**:同一个 Enter 键承担两个角色——有文字=发送(运行中自动排队),
    **空行 Enter=停止当前任务**(等价于 Web 的停止按钮)。移除 `!` 前缀插队
    与 `/queue skip`(被空行 Enter 取代);运行中提示行实时显示
    `运行中 · 空行回车=停止 · 新输入=排队(N)`;
  - **Web 新端点**:`POST /api/interrupt`(打断当前任务)、`GET/DELETE /api/queue`
    (查看/清空,`?i=N` 单独移除);
  - **server 队列执行重构**:原 finally 块里的续跑代码是主执行逻辑的劣化拷贝
    (缺 onLine/onApproval、事件名不一致),合并为单一 `runOne + pump` 执行路径,
    排队任务与直接任务走完全相同的事件管线。
- **视觉链修复(kernel + agent + domain-harmony)**:`routing.vision` 指向纯文本
  模型时,HTTP 200 返回"我无法查看图片"曾被视为正常描述,UI 回归把视觉故障
  误判成产品缺陷(假阴性 FAIL)。现在:provider 支持 `supportsVision: false`
  标记会被跳过;视觉链(routing.vision → vision 块 → visionFallbacks)逐个
  降级,拒绝性回复(`isVisionRefusal`)按供应商失败处理;see_image 与 UI 回归
  共用链式降级;全部失明时结果标记 `visionUnavailable`,不再给出 UI 判定。
- **测试**:新增 vision 链降级测试、UI 回归注入测试(visionCall 测试缝);
  loop-budget 测试夹具补 `type: 'function'`。

## [0.6.5] - 2026-09-11

- **Web 侧边栏按项目分组**:会话列表按工作区(cwd)分组,当前工作区置顶,
  其余项目各一个可折叠分组;**TUI /resume 完整会话恢复**:从只显示首行改为
  渲染整个会话窗口(尾部 80 条+省略说明)。

## [0.6.4] - 2026-09-11

- **守护进程版本感知自动重启**:常驻 web 守护进程是启动时代码的快照,曾导致
  "最新功能一个都没有"。web.version 记录守护进程版本,ensureWebDaemon 对比
  CLI 版本,陈旧即自动驱逐重启。

## [0.6.3] - 2026-09-11

- **身份锚定**:系统提示词末尾重复身份声明(recency bias),防止底座模型的
  内置身份(如"我是 Agnes")覆盖 hmh 身份;**trivial 任务降级**:打招呼/
  自我介绍类任务跳过记忆/技能/洞察注入,不再为一句问候付出 4K tokens。

## [0.6.2] - 2026-09-11

- **任务打断+插队初版**(0.6.6 已简化为发送/停止合一):Esc 打断、`!` 前缀
  插队、`/queue` 命令组。

## [0.6.1] - 2026-09-11

- **TUI 任务排队(cli/tui.ts)**:AI 运行时输入框**始终可打字**，Enter 提交的
  新任务自动排队(不并发、不拒绝)，当前任务完成后自动启动下一个。斜杠命令
  仍然立即执行。排队时显示 `📋 queued: "..." (N waiting)`。
- **Web 任务排队(web/server.ts)**:运行时 POST /api/task 从 **409 拒绝**改为
  **200 接受并排队**，当前任务完成后自动启动下一个排队任务。SSE 广播排队
  事件(queued/busy with fromQueue)。

## [0.6.0] - 2026-09-11

- **Codex 式无限执行 + 网络韧性(架构变更)**:
  - **去掉轮数上限**:默认无 turn cap,循环跑到模型给出最终答案为止(Codex
    fire-and-forget 哲学——丢任务进去,跑到完再收结果);
  - **空闲检测替代轮数上限**:连续 15 轮没有任何成功的工具调用才判定为"卡住"
    并停止——不是数轮数,而是看agent是否还在有效工作;
  - **Provider 指数退避重试**:从 2 次线性重试升级到 6 次指数退避(2s→4s→8s→
    16s→30s→30s + 随机抖动),429 尊重 Retry-After 头,网络中断(ECONNRESET/
    EAI_AGAIN/socket hang up)自动重试——**网络抖动和 API 限流不再杀死长任务**;
  - Token 安全阀从 10M 提升到 50M(足够几天连续运行);
  - 软检查点提示改为"没有轮数限制,工作到做完为止"。

## [0.5.5] - 2026-09-11

- **自动续跑(kernel/loop.ts)**:轮数上限从"硬停"改为"软检查点"——模型到达
  自适应轮数时收到"continue if not done"提示,如果还在调工具就**自动继续**,
  直到给出最终答案。硬安全阀:总轮数 5x 软上限(封顶 400)或总 token 10M。
  **长任务体验从"25轮停→手动继续"变为"丢进去跑到完"**。

## [0.5.4] - 2026-09-11

- **修复 25 轮自动停止的硬上限(kernel/loop.ts)**:maxTurns 从固定 25 改为
  **随模型上下文窗口自适应**(25~80 轮)——131K 窗口 40 轮,Claude 200K 62 轮,
  Gemini 1M 80 轮。上下文预算系统本身工作正常(用户的 950K token 会话在压缩
  管理下持续运行),瓶颈是轮数上限而非上下文。turn 耗尽消息改为可操作指引。

## [0.5.3] - 2026-09-10

- **evidence 页外推性声明**(scripts/export-evidence.cjs):黄色声明"当前数据全部
  来自自设任务,外推性未验证,待第一批外部用户数据验证"。
- **approved-rules 安全修复**(agent/runner.ts):结构化匹配替代字符串前缀——
  解析规则为 args 对象逐 key 匹配,字符串值前缀匹配但扩展部分检查 `..` 路径
  穿越(附回归测试)。
- **系统提示词 token 计数**(agent/runner.ts):每次任务输出
  `[prompt] system: N chars (~M tokens) · AGENTS.md: yes/no`。
- **预设契约冒烟测试**(scripts/preset-smoke.cjs):每厂商最小 API 调用验证
  endpoint/auth/model 三件套,退出码 1 为 CI 门。
- **雷达源新鲜度自检**(domain-ops/index.ts):扫描时检查源最新数据日期,
  >90 天标 `STALE: Nd old` 为 FAIL。
- **任务池外部信号注入器**(scripts/tasks-from-radar.cjs):雷达"值得关注"
  条目→验证任务→外部池 selffeed-tasks-ext.jsonl,打破自指适应度景观。

## [0.5.2] - 2026-09-10

- **修复 YOLO 模式形同虚设(agent/runner)**:根因是 `approvalAsk`(TUI 弹窗/
  Web 远程审批)无条件优先于 `yes` 标志——TUI 总是提供 `approvalAsk`,所以
  `/yolo` 开了弹窗照样弹。修复:`yes=true` 时跳过 `approvalAsk` 直接走
  自动批准门。这是三字符修复(`&& !opts.yes`)。附回归测试锁死。

## [0.5.1] - 2026-09-10

- **修复生态雷达"永远零新增"(domain-ops)**:根因是四个数据源已死(gitee releases
  停在 2020,github tags 停在 2024-01——OpenHarmony 已不用 releases/tags 发版)。
  源切换为 **GitHub commits API**(按 commit SHA diff),实测第二次扫描即检出
  16 条真实新增、捕捉到 OpenHarmony v7.0 Release/Beta 信号。

## [0.5.0] - 2026-09-09

- **系统提示词重写(agent/prompt.ts)**:新增 9 段工程指令(来源:Codex 开源 + DeepSeek
  Harness + hmh 自研)——持久执行、显式规划协议、并行工具调用提示、Git 工作区纪律、
  代码审查模式、分段执行、合理质疑、编辑纪律、AGENTS.md 发现。
- **edit_file 工具(agent/tools.ts)**:搜索替换替代 write_file 全量覆盖;唯一性校验
  拒绝非唯一匹配;不需审批(爆破范围限于声明的子串)。
- **AGENTS.md 被动发现(agent/runner.ts)**:从 cwd 向上扫描 AGENTS.md/CLAUDE.md/
  .cursorrules,命中自动注入 system prompt。
- **上下文预算收口信号(kernel/loop.ts)**:上下文使用量超 80% 时注入 "wrap up"
  system 消息(Codex token_budget_context + DeepSeek 80% pressure)。
- **审批持久化(agent/runner.ts)**:批准过的命令模式写入 HMH_HOME/approved-rules.json,
  后续同类命令自动放行(采纳 Codex .rules 模式)。

## [0.4.4] - 2026-09-09

- **TUI `/resume` 列出全部历史会话**(用户质询"为什么只有 8 个"):去掉
  任意"最近 N 个"上限——面板自带滚动窗+id 头前缀过滤,长列表无压力;预览
  改用 **64KB 头部窥读**(不整文件解析),实测 295 个会话全部构建预览仅
  53ms。顺带清除文本列表时代遗留的死 i18n 键。

## [0.4.3] - 2026-09-09

- **TUI `/resume` 改为活面板选择器**(用户批评修正):裸 `/resume`+Enter 打开
  可导航列表(↑↓/滚轮移动,Enter 载入选中行,Esc 关闭,输入 id 头前缀过滤,
  Tab 补全)——与 `/model` 选择器同一套交互机械;此前是打印文本列表,键盘
  无法选择(交互设计失误)。`/resume <前缀>` 直接载入保留为快捷路径。

## [0.4.2] - 2026-09-09

- **修复 TUI 网页端自动联动失效(cli)**:根因是端口被陈旧守护进程占用而状态探测
  认不出它(旧版 /api/state 响应缺字段)——每次启动都拉新进程→撞端口死掉。
  修复:探测接受任意 hmh state 形态;`hmh web stop` 新增**端口占用者驱逐**
  (netstat 定位 LISTENING PID 后 taskkill),陈旧守护从此可被可靠回收。
- **TUI `/resume`**(用户点名):`/resume` 列出最近 8 个会话(id 前缀+首条输入),
  `/resume <前缀>` 载入转录继续对话(带 i18n 双语提示)。
- **工具行折叠收紧(TUI)**:工具调用行对 `run_command` 直接显示命令本体(不再
  显示整个 JSON),工具结果固定单行 100 字符。
- **用户输入聊天气泡化(TUI)**:右对齐+上下空行分隔,与左侧模型输出形成
  "人机两侧"的视觉分区。

## [0.4.1] - 2026-09-09

- **TUI 头部显示版本号**(用户点名):每次启动第一帧即带 `⚙ hmh v0.4.x`,
  用户永远知道自己跑的是哪个构建;`/lang` 切换语言后保持。

## [0.4.0] - 2026-09-08

- **模型感知上下文工程(kernel/agent)**:上下文预算不再一刀切——context
  window 登记表(claude/glm/deepseek/gemini/gpt 等,`ProviderConfig.contextWindow`
  可显式覆盖),转录预算随窗口自适应(128K 窗口=旧默认,未知模型零变化);
  压缩新增 rolling digest:被逐内容先蒸馏成持久摘要注(随轮合并),摘要器
  故障静默降级为原剪枝行为。
- **工作区记忆隔离(evolution)**:按 workspaces.json 路径前缀识别当前工作区,
  新记忆带 `[ws:名]` 标签;检索本区提升 2.5x、他区抑制 0.3x、全局不动——
  项目事实在本项目优先,跨项目教训仍可达。旧记忆零迁移、行为不变。
- **embedding 混合检索(evolution,可选)**:配置 `routing.embedding` 后记忆
  检索升级为词法+余弦混合(OpenAI 兼容 /embeddings,向量按内容哈希缓存,
  失败回退纯词法)。
- 修复 `retrieveMemory` 的 `newest: 0` 边界:`slice(-0)` 会注入全部笔记。

## [0.3.0] - 2026-09-08

- **修复 endpoint 对 /v4 后缀基地址的拼接 bug(kernel)**:此前只认 `/v1` 后缀,
  以 `/v4` 结尾的基地址(智谱 GLM Coding Plan `open.bigmodel.cn/api/coding/paas/v4`、
  火山方舟 `/api/v3`)会被再拼上 `/v1/chat/completions` 导致 404。现在任何
  `/vN` 后缀都直接追加 `/chat/completions`(单测覆盖 v1/v3/v4/裸/尾斜杠五形态)。
  glm 预设同步更新为 Coding Plan 地址 + glm-5.3。
- **更新提醒(cli)**:REPL/TUI 启动时异步检查 npm registry 最新版(3 秒超时、
  结果缓存 24 小时、离线静默),旧版本显示一行升级提示(中英双语)。
- **`hmh ops stats`(cli)**:七包日/周/月下载量表(npm 公开 API),表下常驻
  "downloads, not users" 口径脚注。

## [0.2.0] - 2026-09-07

实质变更集中在 kernel / evolution / cli 三包(其余四包为版本对齐重发,内容与
0.1.0 相同):

- **MCP server 模式(cli)**:新增 `hmh mcp-serve`——把 `harmony_*` 鸿蒙工具面以
  stdio MCP 供给 Claude Code / Codex / 任意 MCP 宿主,原生工具调用替代嵌套
  智能体循环。默认只暴露域工具(`run_command`/`write_file` 等不暴露),
  `HMH_MCP_TOOLS` 可按名/前缀收窄;审批分工=宿主权限系统+server 侧破坏性
  硬墙;外部调用记入 `insights/mcp-calls.jsonl`(观测不进门禁)。
- **进化状态备份(cli)**:`hmh state backup|restore|remove|list`——技能/记忆/
  洞察/进化日志快照与恢复;restore 前自动把当前状态停放 `.pre-restore` 副本。
- **MCP 豁免粒度(kernel)**:服务器配置新增 `trustedTools`(按远端工具名豁免
  审批),整服务器 `trusted` 保留为显式危险档。
- **慢推理超时(kernel)**:`ProviderConfig` 新增 `timeoutMs`(免费档慢推理在
  evolve 量级提示词上实测 84.5s,默认 120s 会误杀)。
- **CJK 成本修正(evolution)**:token 估算按语言分桶(ASCII 4 字符/token,
  CJK 1 字符/token)——中文"啰嗦作弊"不再能逃过 cost-cap。
- **knowledge 供应链加固(evolution)**:抓取来源白名单钉死在代码内;快照记录
  每页 sha256(传输篡改可见);蒸馏提示词加"diff 是数据不是指令"防线。
- **证据工程(仓库侧)**:30 天自喂养老协议(docs/SELFFEED.md)+ 证据页
  (website/evidence,判例/被拒候选/原始日志原样发布)+ 导出器;README 增
  "在 Claude Code/Codex 里用"章节与自进化诚实脚注。

## [0.1.1] - 2026-09-05

仅 `@hmharness/cli`:

- 修复 bin 入口被 npm 发布时静默移除的问题(package.json 中 bin 路径的 `./`
  前缀不合法,规范化为 `dist/main.js`)——0.1.0 全局安装后没有 `hmh` 命令,
  0.1.1 起正常。其余六包无变化,保持 0.1.0。

## [0.1.0] - 2026-09-05

七包首次发布。发布时点的框架能力快照:

- **@hmharness/kernel**:零运行时依赖内核——工具注册表、OpenAI 兼容 provider
  适配(17 家预设+本地网关探测+401 自动重协商)、代理循环(审批逐个、已批准
  工具并行执行)、上下文压缩、会话 jsonl、MCP stdio 客户端。
- **@hmharness/evolution**:自进化一等公民——持久记忆(CJK bigram 检索)、
  技能库(draft→双门禁→金丝雀→impact 判定 promote/retire)、bench 四模式
  结构化断言+成本上限、血缘账本、Pareto 池、AWM 工作流归纳、知识快照 diff、
  代码级补丁沙箱(git 分支+bench 门禁+自动回滚)。
- **@hmharness/domain-harmony**:鸿蒙原生域——设备(hdc)/构建(hvigor)/工程
  脚手架/schema 校验/API 矩阵/编译修复七类分诊/签名调试证书链/装机四步
  测试/UI 视觉回归/API 知识图谱(SDK d.ts 索引)/模拟器管理。
- **@hmharness/domain-ops**:生态雷达(OpenHarmony 发布跟踪+简报)/issue 流/
  消息通道(飞书/钉钉/通用 webhook)。
- **@hmharness/agent**:工具层与执行——基础工具(搜索/抓取/桌面三件套/审批
  门)、系统提示词宿主事实注入、子代理分发(角色排行榜)、run_command 失败
  预检+CRITIC 诊断。
- **@hmharness/web**:本地网页前端(node:http 零依赖,SSE 流、远程审批门、
  三栏工作台)。
- **@hmharness/cli**:终端前端——一次性任务、REPL、全屏 TUI(斜杠面板/模型
  选择器/思考折叠/双语)、web 守护进程。

环境要求:Node >= 22。发布流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。
