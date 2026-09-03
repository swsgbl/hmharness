# hmharness 开发日志(DEVLOG)

以轮次记录重大演进。每轮:动机 → 关键决策 → 实测证据 → 教训。

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
