# @hmharness/extension

浏览器扩展桥 —— 把 hmharness 智能体接入用户的**真实浏览器**(Chrome / Edge / Brave / Firefox / Safari 载荷)。与 `@hmharness/browser`(驱动 hmh 专属 BrowserOS 实例)互补:这里看到和操作的是用户日常浏览器里的真实标签页。

架构 = 2026 桌面 agent↔扩展的收敛方案(ChatGPT 桌面版↔扩展同款):**本机回环服务 + 一次性短配对码 + SSE 下行(fetch 流)+ POST 上行**。零运行时依赖。

## 快速开始

```bash
hmh extension build --target=all        # 产出三个可加载的未打包目录
hmh extension serve                     # 前台启动桥(127.0.0.1:7789,自动打印配对码)
# 浏览器: chrome://extensions → 开发者模式 → 加载已解压 → 选 dist/extension-build/chromium
#         (Edge/Brave 同理;Firefox: about:debugging 临时载入 firefox 目录的 manifest.json)
# 扩展 popup → 输入配对码 → 配对并连接
hmh extension status                    # 查看桥/配对/连接状态
hmh extension pair | unpair             # 重发配对码 / 吊销令牌
```

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
| 配对 | 扩展 popup,或**演示页**(`http://127.0.0.1:7789/v1/demo-page` 输码即连) | **演示页**(Firefox 特权页禁 WebDriver 脚本,popup 外更普适) |
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
