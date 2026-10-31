# @hmharness/extension

浏览器扩展桥 —— 把 hmharness 智能体接入用户的**真实浏览器**(Chrome / Edge / Brave / Firefox / Safari 载荷)。与 `@hmharness/browser`(驱动 hmh 专属 BrowserOS 实例)互补:这里看到和操作的是用户日常浏览器里的真实标签页。

架构 = 2026 桌面 agent↔扩展的收敛方案(ChatGPT 桌面版↔扩展同款):**本机回环服务 + 扩展源自动授权 + SSE 下行(fetch 流)+ POST 上行**。零运行时依赖。

## 快速开始(自动连接:装好即用,无配对码)

```bash
hmh extension install              # 常驻安装到全部已发现浏览器(见下表分轨)+ 自动拉起桥守护
hmh extension start                # 桥后台守护常驻(hmh web start 同款;装完即用,推荐)
hmh extension serve                # 桥前台运行(调试用;Ctrl-C 停)
# 浏览器启动 → 自动识别桥并连接(零操作;桥后开也行,30 秒内自动接上)
hmh extension stop                 # 停止守护
hmh extension status               # 连接/授权浏览器数 + 安装状态
hmh extension unpair               # 吊销全部浏览器授权(重连自动恢复)
hmh extension uninstall            # 全量撤销安装
```

**没有配对码**。授权 = 扩展 announce(浏览器强制的扩展源 Origin,网页无法伪造)→ 桥直接发本浏览器专属令牌(多令牌并存,最多 8 台,互不踢)。断网/桥未跑时扩展每 30 秒自动重试。popup 仅剩:状态、端口覆盖、重连、取消本机授权、读取自检。

浏览器沙箱限制:扩展不能启动本地进程,桥必须由 CLI 运行(`hmh extension start` 后台常驻)。

## 侧栏对话面板(ChatGPT 扩展同款交互)

浏览器侧栏里**直接和智能体对话**:点扩展图标 →「打开对话面板(侧栏)」。面板消息走 `/v1/chat`(与上行同款令牌鉴权),CLI 侧大脑 = 用户配置的 provider(routing `chat`)+ 工具环 `page_read` / `page_act` —— 模型可以读取你当前标签页、并在你眼前操作它。会话历史按浏览器来源隔离、只存内存(桥停即清)。`hmh extension serve`/`start` 才有大脑;裸桥(如测试)对 `/v1/chat` 诚实回 503。

## MCP 面:任何 AI 客户端都能用你的浏览器(互操作)

桥健康时,`hmh mcp-serve` 自动暴露**只读三件**给 MCP 宿主(Claude Code / Codex 等,配置见根 README):`extension_status` / `extension_tabs` / `extension_page_read` —— 外部 AI 客户端可以列出并读取你真实浏览器的标签页。`extension_page_act`(在你的真实浏览器上动手)**默认不暴露**:它的逐次批准门在 agent 运行器里,MCP stdio 面没有那个交互层——需要时显式开 `HMH_MCP_EXTENSION_ACT=1`(自担:外部客户端将可操作你已登录的页面)。MCP 主机启动时浏览器未开没关系:桥活着就登记,每次调用实时复查、扩展不在就诚实报错并给出下一步。

## 浏览器版本矩阵:你的浏览器该用哪个?(2026-10-31 逐台真机实测)

**扩展代码只有一份,全浏览器通用**;差异只在 manifest 薄层(由构建按目标自动生成)与安装方式。三个通道:

### ① 通用扩展版 —— 全部 Chromium 系浏览器(同一份代码)

**Chrome / Edge / Brave / Opera / 夸克(Quark)/ Helium / Tabbit / BrowserClaw 等**

- 装载:`hmh extension install` 一条命令自动分轨(快捷方式补参;品牌 Chrome 137+ 与 Opera 138+ 已移除该通道 → 浏览器扩展页手动"加载已解压"一次即永久,GUI 可自动化)
- 实测:八台真机 chat E2E 全过(侧栏发消息 → AI 读懂当前网页)
- 持久化:快捷方式启动=常驻;**手动装载一次=任意方式启动都在**(推荐 Chrome/Opera 用户)
- 注意:部分浏览器(Tabit/BrowserOS/BrowserClaw/Helium)进程名叫 `chrome.exe` 但不是 Google Chrome——按 exe 路径区分

### ② Firefox 特例 —— 同一份代码,XPI 装载(非通用通道)

- 当前(release 版):**about:debugging → 临时载入**(会话级,重启浏览器需重载;功能完整已实测——侧栏对话/读网页全通)
- 永久化:需 AMO 签名(计划中);企业策略 force_installed 对未签名 XPI 实测无效
- 装载后主机权限需在 about:addons 手动授予(结构性 opt-in)

### ③ BrowserOS —— 不装扩展,走 ACP 协议(独立通道)

BrowserOS 不需要本扩展:hmharness 通过 **ACP 协议**直连其内置助手面板。

1. 终端运行:`hmh acp-serve`(或全局安装后 `hmh acp-serve`)
2. BrowserOS 助手面板 → 设置 → 添加 **Custom ACP agent** → 只需两字段:
   - **Name**: `hmharness`
   - **Command**: `hmh acp-serve`(或 node 直指全局 `@hmharness/cli/dist/main.js acp-serve`)
3. 对话即达同一智能体大脑(工具审批走 ACP 权限卡)

### 扩展 ID(全通道一致)

`lceccbmgohpgfgckenddombndnklbafm` —— manifest 公钥固定,目录移动不换 ID。载荷位于稳定目录 `HMH_HOME/extension-install/`(**勿移动/删除**)。

连接后,智能体自动获得四个工具(桥在跑且扩展已连接才注册——死工具纪律):

| 工具 | 说明 |
|---|---|
| `extension_status` | 桥/配对/连接状态 |
| `extension_tabs` | 列出用户真实浏览器的标签页(只读) |
| `extension_page_read` | 读标签页内容:标题/URL/用户选区/大纲/表单/链接/正文(只读) |
| `extension_page_act` | 在真实标签页里 click/type/scroll/select —— **每次调用都需用户批准** |

## 跨浏览器矩阵(2026-10 实测,七台真机两连跑全绿)

| | Chromium 系:Chrome/Edge/Brave/Opera/夸克/BrowserOS | Firefox |
|---|---|---|
| 装载(手动) | chrome://extensions 等开发者模式加载已解压 | about:debugging 临时载入 firefox 目录 |
| 装载(自动化) | `--load-extension`(品牌 Chrome 已失效,走 CDP `Extensions.loadUnpacked`) | Marionette `Addon:Install`(temporary,免签) |
| 连接 | **零操作**:后台 announce 自动授权(配对码已废) | 同左(announce 广播 moz-extension://uuid) |
| 发现 | 固定 chrome-extension://id | 后台向桥 `/v1/announce` 广播 moz-extension://uuid |
| 后台 | MV3 service worker | MV3 事件页(不支持 SW) |
| 侧栏 | `side_panel`(夸克/Opera 视版本) | `sidebar_action` |
| 页面读/写 | 清单声明即生效 | **主机权限 opt-in**:需在 about:addons 手动授予"访问您在该网站的数据";授予前工具如实报 `Missing host permission` |
| Safari | 载荷级兼容(`xcrun safari-web-extension-converter`),未在 CI 实测(无 macOS) | — |

同一份零构建载体,`manifestFor` 按目标生成清单,`validateManifest` 双向机检。

## 安全姿态

- 仅绑 `127.0.0.1`;Host 头白名单(拒 DNS rebinding);Origin 必须是 `chrome-extension://` / `moz-extension://` / `safari-web-extension://` 或回环
- 配对码:一次性、5 分钟 TTL、5 次错码锁 60s;Bearer 令牌**只落 sha256**
- 线协议(hmext/1)只有结构化命令 —— 无任何代码求值面
- 主机权限 = 回环桥 + `<all_urls>`:page_read/page_act 只在浏览器授权的站点内工作(MV3 硬边界),浏览器的**站点访问开关**是用户的最终控制
- 扩展令牌与智能体通道密钥(桥状态文件内、随进程生死)互不可替代
- `extension_page_act` 恒审批:在用户登录态的真实页面上动手,持久规则不能豁免
- 命令投递:桥心跳为要求应答的 ping(连失 2 次判死幽灵流);**只读命令跨重连重放**(at-least-once),`page.act` 永不重放(宁超时勿双击)
- 内置回环演示页:`http://127.0.0.1:7789/v1/demo-page` —— 装好扩展后即可在真实 HTML 上试 read/act

## 环境变量

- `HMH_EXTENSION_PORT` 桥端口(默认 7789;`hmh web` 占 7788,桥取邻位)

## 信任文件

- `HMH_HOME/cognitive/extension-pairing.json` —— 配对存储(仅哈希)
- `HMH_HOME/cognitive/extension-state.json` —— 桥运行状态(60s 未刷新即判死)+ 智能体通道密钥

## 测试

- 协议级 e2e(`bridge.test.ts`):用与 background.js 相同的传输代码打真实回环,无需浏览器
- **真实浏览器 e2e**(`real-browser.test.ts`):逐台装载验证本机全部 Chromium 系浏览器(BrowserOS/Chrome/Edge,无则跳过)——BrowserOS/Edge 走 `--load-extension`;**品牌 Chrome(2025+)已忽略该 flag**(且会毒化 DevTools 通道),改经 browser 级 WebSocket 的 `Extensions.loadUnpacked` 装载。CDP 驱动 popup 配对,验证真实 background.js 附流并响应智能体命令
- 连接诚实性:桥心跳为**要求应答的 ping 命令**(连失 2 次判死,防 MV3 worker 死后残留的幽灵流);SW 端 40s 无数据即主动弃流重连 + 30s alarms 自愈
