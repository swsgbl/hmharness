# hmharness 开发日志(DEVLOG)

以轮次记录重大演进。每轮:动机 → 关键决策 → 实测证据 → 教训。

---

## 2026-09-04 · TUI /model 选择器交互修复轮

**动机**:用户实测反馈"tui 界面的 /model 列出来的模型列表,上下键无法选择,用鼠标
也选中不了"。截图取证(输入框为空、模型列表是转录区普通文本)定位真相:代码逻辑
无 bug(无头 5/5 PASS),用户走进的是**裸 `/model` 命令打印的静态列表死路**——该列表
纯文本、无可选项;活面板只在输入含 `/model…` 时存在,命令跑完输入清空,面板就没了。
另有暗雷:输入 `/model` 直接回车会**静默切到第一个模型**(Enter 语义过急)。

**落地**(tui.ts / i18n.ts,对标 Claude Code 两段式选择器):
- 裸 `/model`+Enter **打开交互选择器**而非打印死列表(转录留记录+聚焦活面板,
  openModelPicker);`/model <name>` 手输路径不变
- Enter 语义分层:输入恰为 `/model` → 开面板不执行;`/model `(已进面板)或带过滤
  词 → 选中高亮行并执行。第一记 Enter 不再误切模型
- **Esc 关闭面板**(清草稿;精确匹配 `\x1b`,箭头序列不受扰;顺手删除了 onKey 尾部
  重复的旧 Esc 分支)
- **滚轮优先驱动面板**:面板开着时 SGR 滚轮事件移动选择(此前滚轮只滚转录,面板
  视若无睹);面板关着仍滚转录
- 面板底部常驻 **i18n 提示行** `panelHint`(↑↓/滚轮选择·Enter 确认·Esc 关闭,
  zh/en 双语),选择器从此无需看文档即可上手;cmdModel 描述同步改写
- 布局账本:提示行计入 cmdRows(+1),viewH 同步,转录不被挤爆

**实测**(tui.test.ts 新增 5 个 runtime 级用例,真 stdin data 接线喂键,非 mock):
裸 /model+Enter 不触发命令且聚焦面板 ✓;↓↓+第二记 Enter 提交
`/model nvidia-vision` ✓;SGR 滚轮上下移动选择 ✓;Esc 清空 ✓;斜杠命令面板
`/m`+Enter 仍取 COMMANDS 序首项(实测序为 /model,顺带发现其提交即路由进选择器,
行为自洽)✓。全仓 43/43 绿,typecheck+七包构建+dist 冒烟(skills/no-TTY 双语)过。

**教训**:①"代码正确"≠"用户可达"——活面板逻辑全对,但一条静态列表死路就把用户
挡在门外;交互入口必须收敛到单一活物;②Windows ACL 坑:某次提权进程构建出的
dist/patches.* 带 Users:RX-only 继承 ACE,普通 shell 下 rename 可行而 delete/open-write
EPERM——绕行(改名让路+重建),根因留 elevated 清理;③npm 在本机 shell 偶发
"Invalid abbreviated flag"启动失败,直跑 tsc/`node --import tsx --test` 稳定。

**第二轮(同日,用户复测后)**:用户仍报"上下键选不了、鼠标也选不了",且点名
**TUI 没有语言切换命令**。两个真因+一个缺口:
- **SS3 光标键**:上个程序可能把终端留在 DECCKM(应用光标模式),方向键以
  `\x1bOA/B` 而非 `\x1b[A/B` 到达——原代码只匹配 CSI,SS3 被末尾的
  `data.startsWith('\x1b')` 静默吞掉,症状恰是"按了没反应"。修复:启动/退出均写
  `\x1b[?1l` 强制 CSI;onKey 顶部 `\x1bO[A-H]`→`\x1b[A-H]` 归一化(双保险)
- **conhost QuickEdit**:用户点列表想"选中"→终端进入文本选择模式,方向键被终端
  吃掉移光标选文本,应用收不到。修复:**面板=模态**——面板开着时自动开
  SGR 鼠标上报(1000+1006),**点击=选中并确认**(render 记录每行的屏幕行号,
  SGR row 1:1 命中)、滚轮驱动选择;面板关闭(Enter/Esc/清空)立即关上报,
  原生拖选复制即时恢复。/mouse 全局开关与模态上报合并成单一
  syncMouseReporting 状态机
- **缺口:/lang 命令**——此前 TUI/REPL 无界面语言入口(只有 --locale/HMH_LOCALE/
  Web 芯片)。新增 `/lang [zh|en]`(省略则中英切换):kernel setLocale 持久化
  (setChatRoute 同款读改写)+ TUI 运行时全量刷新(rt.configure+strings 重绑)+
  REPL 同步获得;nextLocale 纯函数可测

**实测**:TUI 测试 12/12(SS3 上下键导航/模态上报开-关/点击第 3 行提交
`/model nvidia-vision`/nextLocale 边界);全套 48/48;dist 字节级验证(?\1l、SS3
归一化、点击正则、syncMouseReporting、/lang 全在);setLocale 经 dist kernel
隔离 HMH_HOME 往返持久化实证;REPL /lang 交互节奏冒烟(spawn+延时写入模拟真人)
——切换行+切换后 /help 以英文渲染(证明运行时刷新而非仅落盘)。管道整块喂入的
"多行丢失"是 readline 行交付竞态(历史坑),交互终端不存在。

**教训**:④"无头通过"只覆盖程序一半,终端是另一半——终端模式残留(DECCKM/
QuickEdit)能把正确的键处理整个短路;对键盘/鼠标类交互,要么真终端实测,
要么把终端的两态(CSI/SS3、上报开/关)都纳入无头矩阵;⑤多行管道冒烟必加
逐行延时,await 间隙里的行会被 readline 丢掉,交互终端不存在。

**第三轮(同日,/mouse 移除)**:用户质问"/mouse 存在的意义是什么""你想给自己
留历史代码包袱吗"。盘点:模态上报+终端滚轮转换已覆盖 conhost/WT/VS Code 全部
目标环境,/mouse 唯一受益者是 tmux/个别 Linux 终端用户——而本项目定位
Windows/HarmonyOS 开发机,受益者集合为空。保留=为不存在的用户维护开关+
i18n 键+文档心智负担。**删除**:COMMANDS 项、handleLine 分支、toggleMouse、
mouse 字段、状态行 /mouse 提示尾巴、i18n 六键(mouseOff/cmdMouseOn/Off/
cmdMouse,zh/en+接口)——syncMouseReporting 简化为纯模态(面板开→上报,
面板关→还原,零用户可动开关)。**教训**:⑥兜底开关不是免费品——每个开关
都是文档、i18n、测试和用户心智的永久负债;兜底只在"目标用户里真有人踩"
时才值得留,否则就是历史包袱。

**第四轮(同日,双菜单根除+全量扫描)**:用户截图抓到裸 /model 输出**两个模型
菜单**——一个可选中(活面板)一个不能(静态列表)。根因:上一轮修 /model 时
只改了键盘路径(输入框直敲回车),**没改驱动路径**(/斜杠面板选中 /model 命令
进入同一 handleLine,却仍打印静态列表+开活面板)——"修症状不修路径"的复发。
用户令"全量扫描整个工具确保无同类问题",建立三道脚本化扫描:A 硬编码
UI 文案(addText/stdout.write 含中文且无 t.) B COMMANDS×REPL/TUI 处理器
矩阵 C dist 双菜单残留。**修复**:①裸 /model 不再打印静态列表,活面板是
唯一菜单(transcript 断言钉死:无 `z-ai — ` 静态行;键盘/面板两入口同一
openModelPicker);②扫描抓出三处漏网硬编码(/providers scan 成功文案、
/providers 列表尾巴、REPL [thinking] 标签)全接 i18n(复用 cmdProvidersAdded,
新增 cmdProvidersScanHint/thinkingLabel);③REPL 两缺口补齐(/providers [scan]
TUI 有而 REPL 报 unknown command、/clear 同缺)——COMMANDS×处理器矩阵全绿。
**实测**:TUI 13/13(新增面板路由单一菜单断言);全套 49/49;REPL spawn+延时
实证 /clear//providers 生效+无 unknown command;三道扫描 ALL CLEAN。
**教训**:⑦同一动作的多条入口路径必须收敛到同一出口——修交互 bug 时要枚举
"用户到达这里的所有路径",只修自己想到的那条=给用户留另一条坏路;⑧扫描
要脚本化且可重跑(人眼审一遍会漏,正则矩阵不会)。

---

## 2026-09-03 · 代码级自进化轮(DGM 桥)

**动机**:用户深度质问"自进化是各 agent 互相改底层代码,还是仅在提示词层面做文章?"
诚实盘点结论:此前进化=纯提示词层(技能 markdown 注入系统提示词,记忆检索注入),
**永远不改代码**。这不是 DGM 意义上的自进化。

**落地**(patches.ts,evolve.ts 步骤 6.5):
- proposePatches:元模型读会话信号+最热工具源码,提 ≤1 个 find/replace 补丁
- isPatchableFile 硬守卫:只允许 `packages/.../src/*.ts`;**永禁 kernel loop/provider**
  (自举悖论:改坏循环=智能体永久瘫痪)/config/security
- 沙箱周期:创建隔离 git 分支 → **补丁在分支上提交**(实测抓到的真 bug:不提交则
  checkout main 时未提交改动会漂移) → 全链 build + 双样本 bench → 过门合并/回归回滚
  (checkout main + hard reset + 删分支,零残留)
- 红线更新(CONTRIBUTING):进化写 skills/+memory/+可提代码补丁,四条件同时满足

**实测**(sandbox-e2e.test.ts):临时 git 仓跑完整周期,merge 路径(补丁落 main+分支删)
与 revert 路径(main 完好+树净+零残留)全部实证。

**教训**:用户问"所有修改你都验证过了吗"——诚实回答暴露了端到端缺口;写测试当场
抓到"补丁未提交"真 bug。**门禁绿 ≠ 行为对;新功能收工前必问:这条代码路径真的
从头到尾跑过一次吗。**

---

## 2026-09-02~03 · 智能体内核成熟轮(三轮实战审计)

**动机**:用户提供三份完整运行记录(freellmapi 配置 25 轮 71 万 token / 工具安装 /
新闻查询),逐份审计,证据驱动修根因。

### 第一轮:环境事实与反馈通道
- 根因①:模型不知道宿主是 cmd.exe——40+ 次 grep/head/wmic 失败。修复:系统提示词
  注入宿主事实(平台/shell 身份/等价命令速查/探测优先/禁全盘扫/失败两次换策略)
- 根因②:工具失败模式随会话丢失。修复:失败模式自动入长期记忆
- freellmapi 拒 Bearer 只认 X-Api-Key(实测同 key 两头对照)→ chat()/chatVision() 401
  自动重协商 + authHeader 字段

### 第二轮:提示词不够,硬墙来补
- 模型重复同一失败 curl 10 次(Unix 管道 6 次)——提示词已告但惯性无视 → 工具层硬墙:
  unixPipeOnWindows 预检(只查宿主段首词,容器内 Unix 词不误拦)+ 重复失败第 3 次短路
- DENY 误报:单文件 del 被硬拒 → 精度分级(单文件放行/递归删只拒盘根+系统目录+家目录)
- `npx skills add` 断头路(装别的 agent 格式)→ `hmh skills add`(三种布局,实测装 8 个 gsap 技能)

### 第三轮:结构化能力补全(用户批"只是修修补补,不是底层重构")
- Web 跨任务连续对话记忆(此前 Web 每任务失忆,REPL/TUI 却有)
- web_search(零 key DuckDuckGo)+ web_fetch(URL→可读文本)
- 输出人本化:工具流折叠一行可展开,AI 回答为主体(Claude Code 信噪分离)
- 内核并行工具执行:审批串行保序+执行并发(4×150ms 慢工具 ~1x 而非 4x,计时单测)
- **三层即时反馈**(用户批"8 轮才洞察太滞后"):Tier1 系统级错阈值 2→1 即记 /
  Tier2 每出错任务完成即一次小模型反思入记忆(下任务即受益)/ Tier3 进化轮 8→3
- 审批根因修复(用户实测抓到:自动模式仍弹窗——远程审批钩子无条件挂载覆盖 yes 标志)
- YOLO 三端(web 三档+TUI/REPL /yolo+CLI --yolo);状态行迁输入框上方带模式徽标
- 桌面自动化三件套 desktop_screenshot/click/type(看→动→验,PS here-string 在
  -Command 内联会炸的坑:改 Add-Type -MemberDefinition)
- 浏览器自动化:Windows 无头输出全空(平台限制,4 种参数组合实测)→ 诚实路线
  browser_open 可见浏览器+桌面三件套(实测 281KB 真实渲染)
- 会话管理:重命名(titles 映射,审计 jsonl 不可变)/归档/删除(trash 可恢复)
- i18n 守门:页面 L.引用 vs zh/en **双字典分别**校验;TUI COMMANDS 对称检查
  (undefined 事件的根治:缺键=构建失败)

**教训**:①提示词防线对模型习惯性行为不够,关键约束必须工具层硬执行;
②e2e 实测要选"可见范围"内的目标(列表截断 50 条,最老的在 API 视野外);
③JSDoc 里 `packages/*/src/` 的 `*/` 会提前终结块注释;
④`.cmd` shim 在现代 Node execFile 直 spawn 会 EINVAL。

---

## 2026-09-01~02 · 双前端对标与官网轮

- Web 三栏(deepseek-harness 式)+ 工作区实体(切换=服务端 chdir+会话按 cwd 分组)
  + 目录选择器(盘符/面包屑)+ /model 运行时路由切换 + providers 探测(env+opencode+本地网关)
- hmh tui 全屏重写(Claude Code 式:备用屏/斜杠面板 ↑↓ 选择/宽度感知输入框换行)
  ;原生拖选复制与滚轮共存(默认零鼠标上报,滚轮经终端转 ↑↓)
- YOLO/审批/状态行;GSAP 全站动画(CDN 守卫降级);官网双语上线 ndtool.cn/hmharness/
  (旧路径 301)
- 旧线退役:codelin/harmony-harness 资产甄别归档→本地+远程清除;实战 insights 并入长期记忆

---

## 2026-08-28 之前 · Phase 0-3 + 加固 + 模拟器自治

见 docs/ROADMAP.md 各 Phase 节与 docs/ARCHITECTURE.md(四包起步→七包、MCP、
进化循环、参数化脚手架、模拟器无头全生命周期、CI、多厂商路由)。
