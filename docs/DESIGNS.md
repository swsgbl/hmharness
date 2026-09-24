# hmharness 交互设计定案台账(DESIGNS)

> 用途:**已定案的交互/UX 决策清单**。改任何 UI 行为前必须先查此文件——
> 若已有定案,不得无记录地推翻;推翻必须在本文件追加"复案"条目+理由+提交号。
> 每条定案同时写入代码注释(`settled design, <commit>`)与对应测试断言。
> 2026-09-04 事件教训:0df4ba7 定案"头部永远空闲",18210e1 未查台账即改回
> 头部轮换——用户抓到"怎么又恢复了"。此后所有行为级修改先过本表。

## TUI(全屏终端)

| # | 定案 | 依据 | 提交 | 状态 |
|---|------|------|------|------|
| T1 | **头部=纯身份条**(logo/模型/cwd/技能+🔥徽标),**无任何状态字样**——运行指示**只**在输入框上方状态行(旋转字符+运行中+子状态,空闲隐藏) | 状态行迁位(0df4ba7)时旧位只显示"空闲"=孤儿状态位,用户定案"迁了位置就删旧位"(T1-v2);Web 状态行同位 | 0df4ba7 迁位→af09228 复议 T1-v1→**T1-v2 定案(本轮)** | ✅ 生效 |
| T2 | 裸 `/model`(任意入口:直敲/斜杠面板选中)→**只**开活面板;**不**打印静态列表 | 一动作一出口;双菜单事故(1679b1f) | 1679b1f | ✅ 生效 |
| T3 | `/model` 两段式:第一记回车开面板,↑↓/滚轮/点击选择,第二记回车确认 | Claude Code 选择器范式;防首记回车静默切模型 | 3e04867+843061a | ✅ 生效 |
| T4 | 鼠标默认**零上报**(原生拖选复制永可用);**仅**面板打开期间模态开 SGR 上报(点击选行/滚轮选择),面板关即还原;无用户可动开关 | conhost/WT/VS Code 滚轮自转 ↑↓;/mouse 开关已删(受益者空集,38aeeda) | 38aeeda | ✅ 生效 |
| T5 | 思考流**折叠**:流式一行「∴ 思考中 · 尾部」,阶段切换收为「∴ 已完成思考」;原始思维链永不显示 | 模型内部规划≠用户输出;Claude Code 同款 | 已入(见 DEVLOG 2026-09-03 节) | ✅ 生效 |
| T6 | 方向键归一化:SS3(`\x1bO[A-H]`)与 CSI(`\x1b[A-H`)都识别;启动/退出强制 `\x1b[?1l` | 终端 DECCKM 残留会短路方向键 | 843061a | ✅ 生效 |
| T7 | Esc=关闭面板/清空输入;历史行走 ^P/^N(方向键留给滚轮语义) | readline 标准;方向键双语义冲突 | 843061a | ✅ 生效 |
| T8 | 输入框宽度感知自动换行(CJK 2 列),上限半屏 | CJK 溢出撕裂布局事故 | 已入(DEVLOG 2026-09-03) | ✅ 生效 |
| T9 | **Esc 三态**(codex interrupt 对齐):①模态/面板打开→先关面板(T7 优先);②运行中→**中断当前轮**(in-flight 工具调用先完成,排队任务仍跑);③空闲+输入非空→清空输入;④空闲+空输入→进入 fork-edit 预备(T13) | 对标 codex Esc=interrupt_turn;与 T7 协调定序 | 50f45a9 | ✅ 生效 |
| T10 | **运行中交互**(codex 对齐,与 Web W7 一致):**Enter=排队**下一轮(输入非空);**Ctrl+Enter=注入当前轮**(经内核 inject 通道,轮边界生效);**空 Enter 不再停止**(复案见下)——停止=显式 Esc | 对标 codex Enter-inject/Tab-queue;跨前端一致 | 50f45a9 | ✅ 生效 |
| T11 | **`!` shell 前缀**:行首 `!` 直接执行本地 shell 命令,输出以工具结果样式插入转录;**走 run_command 同一门禁**(DENY_PATTERNS 硬拒 + shellgate + TUI 审批对话框),禁止旁路 | 对标 codex !;硬约束 #5 门禁不动 | 50f45a9 | ✅ 生效 |
| T12 | **`@` 文件模糊搜索**:输入 `@` 打开工作区文件面板(纯函数子序列打分,复用 fs-utils fuzzyScore;跳过 node_modules/.git/dist/.next/.cache、深度≤12、条目≤3000、结果≤20、symlink 不跟随);Enter 插入 `@<相对路径>` 进输入框,Esc 取消 | 对标 codex @ 模糊搜索;与 Web W6 同源算法 | 50f45a9 | ✅ 生效 |
| T13 | **Esc Esc 编辑并 fork**:空闲+空输入时两次 Esc(≤800ms)把上一条用户消息载入输入框;发送后开**新会话**(内核 forkFrom 记录父会话 id,新线程 resume=fork 点之前的全部上下文,编辑后的消息取代原消息) | 对标 codex Esc Esc=edit+fork;thread 语义可溯源 | 50f45a9 | ✅ 生效 |
| T14 | **Ctrl+R 历史搜索**:增量子串搜索提交历史(最新在前,≤50 条),Enter 采用进输入框,Esc 取消,^P/^N 或方向键移动;^P/^N 原历史行走保留 | 对标 codex Ctrl+R | 50f45a9 | ✅ 生效 |
| T15 | **Ctrl+T 完整转录回放 overlay**:全屏展示完整会话(含被折叠的工具输出全文,由驱动侧 fullToolLog 供给),↑↓/PgUp/PgDn/g/G 滚动,q/Esc 返回;实现为通用 overlay 基座,长输出 pager(B9)复用 | 对标 codex transcript overlay | 50f45a9 | ✅ 生效 |
| T16 | **M4 命令族**(B7,codex 对齐):`/compact`(内核上下文压缩+报告释放量)/`/diff`(工作区 git diff+未跟踪文件 pager 查看)/`/new`(新会话,同 /clear)/`/fork`(下一任务 fork 新线程,继承全上下文)/`/copy`(最后一条 AI 输出→剪贴板,clip/pbcopy/xclip 降级链)/`/plan`(计划模式:system 指令"先出计划待确认再执行"逐任务注入)/`/goal`(会话目标读写,与 Web A6 共用 kernel goal 存储)/`/usage`(上下文占用)/`/review`(审查工作树任务模板)——**TUI 与 REPL 双端全覆盖(C1)** | 对标 codex 命令族;C1 矩阵纪律 | e011d27 | ✅ 生效 |
| T17 | **工具 cell**(B8):工具调用+结果=可折叠 cell,默认一行摘要(W1/T5 精神);**空闲+空输入按 `z`** 展开/折叠最后一条 cell 到完整输出(有草稿时 z 只是输入) | 对标 codex exec/history cell | e011d27 | ✅ 生效 |
| T18 | **长输出自动 pager**(B9):工具输出超过 ~2 屏自动进 overlay(q/Esc 随时回到流);Ctrl+T 与 /diff 复用同一 overlay 基座 | 对标 codex pager_overlay | e011d27 | ✅ 生效 |
| T19 | **流式 markdown 着色**(B10):`say` 流按"已完成的行"一次性着色(标题青加粗/围栏列表引用 dim),进行中的尾行保持原样——**已稳定的行绝不重排** | 对标 codex markdown 流式渲染;稳定行不重排约束 | e011d27 | ✅ 生效 |
| T20 | **M5 TUI 项**(B11/B12/B13/B14):`/statusline <tpl>` 自定义底栏({model}/{cwd}/{skills}/{mode}/{queue}/{version},config.json tui.statusline,未知占位符原样显示);**Ctrl+G** 外部编辑器编辑草稿($EDITOR/notepad,临时文件往返);**/keymap <action>=<key>** 重映射 inject/historySearch/transcript/externalEdit/interrupt(parseKeySpec 白名单,config.json tui.keymap,默认键不变);**帧率/脏区**(B13):dirty-flag 渲染架构已在——无事不重绘,spinner 仅 busy 期间 tick,无需改动 | 对标 codex /statusline、Ctrl+G、/keymap、frame_rate_limiter;B13 由既有架构满足 | 53042cc | ✅ 生效 |
| T21 | **鼠标滚轮全终端直通**(0.14.10,**已被 T23 复案推翻**):SGR 鼠标上报自启动常开 | ~~多系统实测滚轮失效~~ 常开捕获同时杀死了所有终端的原生划选复制 | 17cf0d4 | ⛔ 复案 |
| T22 | **括号粘贴模式**:?2004h 自启动常开——多行粘贴经 sanitizePaste(剥 200~/201~ 标记与转义序列,换行折叠为空格,262144 字符上限)作为**一条可审输入**插入光标处,绝不逐行自动提交;粘贴体跨 stdin 分片累积(pasteBuf);带外字节(标记前/后)走正常按键路径 | 终端粘贴多行时原始 \r 会逐行触发提交=误执行多任务;各主流终端(Windows Terminal/VTE/Konsole/xterm)均支持 ?2004h | 本轮 | ✅ 生效 |

## Web(浏览器端)

| # | 定案 | 依据 | 提交 | 状态 |
|---|------|------|------|------|
| W1 | 工具流折叠为一行可展开,AI 回答为视觉主体 | 信噪分离(Claude Code/自家 TUI 对齐) | 已入 | ✅ 生效 |
| W2 | 状态行(空闲/运行+模式徽标)在输入框上方——与 TUI T1 同构 | 跨前端一致 | 已入 | ✅ 生效 |
| W3 | 审批三档 ask/auto/yolo;unattended(yes/auto)不挂远程审批钩子 | 审批根因修复(远程钩子无条件挂载覆盖 yes) | 已入 | ✅ 生效 |
| W4 | 会话侧栏三操作:重命名(titles 映射)/归档(archive/)/删除(trash/ 可恢复),审计 jsonl 不可变 | 产品完整性 | 已入 | ✅ 生效 |
| W5 | **设置中心**(侧栏第六项 ⚙):模型页=provider 增删改(baseUrl/apiKey/model 表单,保存即写 config.json 热更新;apiKey 省略=保留原值、显式空串=清除,stateObject 只回传 hasKey+末4位);常规页=locale/approval(ask|auto)/autoEvolveEvery/autoPatch/theme(dark|light|system) | 对标 dsh 设置→模型/常规;密钥不回传原则 | f2d7948 | ✅ 生效 |
| W6 | **输入区三件套**:①`/` 命令面板(Web 子集与 TUI COMMANDS 对齐,`POST /api/command` 分发);②`@` 文件模糊搜索(纯函数子序列打分,`GET /api/fs/search`,仅当前工作区、跳过 node_modules/.git/dist/.next/.cache、深度≤12、条目≤3000、结果≤20、symlink 不跟随);③图片粘贴/选择附件(png|jpeg|webp base64 白名单,解码后 ≤6MB,对接 see_image 视觉链) | 对标 dsh ui-commands/ui-reference/ui-attachment;零依赖内核一等公民 | f2d7948 | ✅ 生效 |
| W7 | **运行中注入**=Ctrl+Enter(输入非空且运行中):文本经 `POST /api/inject` 进内核 injections.poll,在轮边界注入为 user 消息;Enter 保持排队语义(不改);inject 只作用于当前轮,任务结束的迟到推送自然落入下一任务队列 | 对标 codex Enter-inject;与 TUI B1 共用内核注入机制 | f2d7948 | ✅ 生效 |
| W8 | **右栏 tab 体系**(详情/文件/预览):详情=原工具详情;文件=工作区只读树(`GET /api/fs/read` 64KB 上限+8KB NUL/控制字节嗅探+UTF-8 fatal 解码兜底,二进制给占位);预览=点击回答中的路径引用在右栏打开;可折叠+宽度拖拽 300-600px localStorage 记忆 | 对标 dsh ui-sidebar-right;路径引用点击经 maybePath 防误触 | f2d7948 | ✅ 生效 |
| W9 | **工具 keyed 渲染**:edit_file/write_file 结果按 unified diff 渲染(+绿/-红/@@灰/文件行 dim,`looksLikeDiff` 门);web_search 结果渲染为链接卡片;harmony 类长日志折叠尾部;代码块 token 着色(关键字/字符串/注释/数字)+复制键 | 对标 dsh ui-tool/ui-renderer;W1 折叠一行默认保留 | f2d7948 | ✅ 生效 |
| W10 | **会话目标栏(A6)**:顶栏 🎯 chip 显示当前 goal(stateObject 下发,与 TUI /goal 共用 kernel goal 存储);点击展开内联输入行,✓ 保存 ✕ 清除(`POST /api/goal`);计划卡=回答中的编号步骤(≥2,纯函数 extractPlan)以可勾选清单固定在对话顶部 | 对标 dsh ui-goal/ui-plan;与 TUI T16 /goal 同源 | c7953a4 | ✅ 生效 |
| W11 | **权限预设卡片(A8)**:mode 下拉旁 ▾ 弹三卡(审批询问/自动批准/YOLO,各带危险性说明,🔥 徽标语义与 TUI 对齐);选择即写 select 并触发现有 change 路径 | 对标 dsh ui-permission-presets;W3 三档语义不变 | c7953a4 | ✅ 生效 |
| W12 | **交付物 chips(A9)**:edit_file/write_file 的路径在任务结束时渲染为可点击 chips(去重保序,纯函数 extractDeliverables),点击在右栏预览(A5) | 对标 dsh ui-deliverables | c7953a4 | ✅ 生效 |
| W13 | **消息反馈(A10)+主题(A11)**:每条 AI 回答带 👍/👎,写入 `insights/explicit-feedback.jsonl`(自描述存储,不污染进化 feed 的严格 Insight 联合类型;`POST /api/feedback`);CSS 变量 token 化(dark/light/system 三态,`body[data-theme]`,`POST /api/config` 持久化+SSE 状态回传) | 对标 dsh ui-message-feedback/ui-theme;反馈字段 outcome 语义以独立文件实现 | c7953a4 | ✅ 生效 |
| W14 | **M5 Web 项**(A13/A14/A15):会话视图=轨迹时间线(工具调用按序计数圆点条)+全文搜索(输入即过滤渲染行);`POST /api/open` 在系统文件管理器打开工作区路径(仅工作区内,insideWs 守卫;win32 explorer /select) | 对标 dsh ui-trajectory/ui-open-in-app + 会话搜索;A12 定时提醒未做(可裁量) | 本轮 | ✅ 生效 |

## CLI/REPL

| # | 定案 | 依据 | 提交 | 状态 |
|---|------|------|------|------|
| C1 | COMMANDS 命令集 TUI/REPL **全覆盖**(扫描矩阵 B 钉死) | /help 广告了就必须存在 | 1679b1f | ✅ 生效 |
| C2 | 所有 UI 文案走 i18n 字典(zh/en 对称+键存在性单测) | "undefined"事件根治 | 已入 | ✅ 生效 |

## 复案记录(推翻定案必须在此登记)

| 日期 | 原定案 | 新决策 | 理由 | 提交 |
|------|--------|--------|------|------|
| 2026-09-04 | T1-v1(0df4ba7:头部保留"○空闲"+🔥) | **T1-v2:头部删除一切状态字样,🔥并到左侧身份条** | 用户推翻:"既然更换了位置,就应该把旧位置的删除"——迁位不删旧位=孤儿状态位=包袱;我此前两轮(18210e1 改轮换、af09228 恢复空闲字样)都没理解到"删除"才是原意 | 50f45a9 |
| 2026-09-17 | T7 运行中空 Enter=停止当前任务(0.6.0 起的"发送键=停止键"语义) | **运行中空 Enter 不再停止**;停止=显式 **Esc**(T9) | 对标 codex:Esc=interrupt_turn、Enter=inject/queue 的语义更清晰,停止与排队/注入不再挤在同一把键上;空 Enter 只提示(Esc 停止/输入排队/Ctrl+Enter 注入) | 50f45a9 |
| 2026-09-19 | (tui.ts 代码注释内嵌定案)鼠标上报仅面板打开时开启,关闭即关——依赖终端把备用屏滚轮译为方向键 | **T21:SGR 上报自启动常开** | 用户多系统实测:除 Win11(Windows Terminal)外,其余系统终端滚轮均无效——"滚轮→方向键"翻译非普适,模态方案等于在多数终端上禁用了滚轮 | 本轮 |
| 2026-09-21 | T18/B9: 工具输出超 ~2 屏**自动**进入全屏 pager overlay | **自动抢屏取消,改为折叠 cell+提示行(z 展开/Ctrl+T 全文)** | 用户在宿主+全部虚拟机实测:运行中突然整屏原始输出(读作「代码泄漏」),任务看似停止,Esc 后「恢复」——任务从未停,是 overlay 盖住了实时流;干净环境(无 MCP)也必现 | 本轮 |
| 2026-09-19 | T16 中 /copy 的剪贴板链=win32 clip/darwin pbcopy/linux 硬编码 xclip | **/copy 改走 clipboardCandidates 候选链**:Wayland 会话优先 wl-copy,X11 依次 xclip→xsel,逐个尝试直到 spawn 成功 | 硬编码 xclip 在纯 Wayland 会话(Omarchy)必然失败;产品要求全系统核查复制/粘贴功能 | 本轮 |
| 2026-09-19 | T21:SGR 鼠标上报自启动常开(滚轮全终端直通) | **T23:捕获默认关+?1007 备用屏滚动**:常开 ?1000h/?1006h 把点击/拖拽也捕获=所有终端失去原生划选复制(宿主机原有能力也回归丢失,实测反馈修正);默认改为 ?1007(终端自行把滚轮译为方向键,零点击捕获,方向键路径本就滚动转录);捕获仅在面板打开时临时开启(旧行为恢复)或用户 /mouse 显式强制(持久化 tui.mouse,面向既不翻译滚轮也不认 ?1007 的终端如老 conhost) | 选中/复制是不可牺牲的原生能力;滚轮必须靠不碰点击的机制实现 | 本轮 |

## 维护规则

1. 新交互定案 → 本文件加行 + 代码注释 `settled design, <hash>` + 测试断言三件套。
2. 想改已定案行为 → 先在本表登记复案(理由必须成立),再改代码,再更新本表状态。
3. 每轮 dev 的 DEVLOG 增量记录"做了什么";本表是**当前有效**决策的单一事实源。
