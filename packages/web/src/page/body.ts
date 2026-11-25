/**
 * @hmharness/web - page/body.ts - 静态 body 骨架:三栏布局(side/main/rightbar)、五个视图容器、wspick/cmdpal/pairmod 弹层、按钮基础样式与 script 开标签
 * 2026-11-26 无障碍改造(modern-web-guidance):side/rightbar 是 <aside>、<main> 里有一个屏幕阅读器可见的 <h1>;
 * 会动作的芯片/建议项都是原生 <button>;三个弹层是 role="dialog"(背景由 uilite.ts 的 wireModalInert 置为 inert);
 * 右栏是标准 tablist。图标按钮靠 aria-label 命名,由 core.ts 的 setLabels 随语言同步。不变量由 __tests__/a11y.test.ts 守门。
 * 页面不加载任何第三方资源: 2026-11-25 起动效层改用 Web Animations API(见 uilite.ts 的 createMotion),
 * 原先同步加载的 GSAP CDN 脚本已移除。script 开标签里的 __HMH_NONCE__ 是显式占位符, 由服务端在每次
 * 响应时换成新随机数(包内 security-headers.ts); 新增 <script> 必须带上同一个占位符, 否则会被 CSP 拦下。
 * P1-3 拆分自 page.ts(基线 682d4fc 行 482-706):逐字搬运的页面
 * 源码片段,由 page.ts 装配层按序拼接,字节级一致由拆分期守门脚本校验。
 * 模板字面量规则同 page.ts:无裸反引号,页面 JS 内不用插值(字符串拼接),
 * 正则反斜杠双写。
 */
export const BODY = `<body>
<div id="app">
  <aside id="side">
    <div id="brand"><span class="logo">hmh</span><span class="badge minhide">HARNESS</span><button id="collapse" type="button" title="收起侧栏" aria-label="收起侧栏">«</button></div>
    <button id="newbtn" class="primary">＋ <span id="new-label" class="minhide">新会话</span></button>
    <nav aria-label="视图导航">
      <button class="nav on" data-view="chat" aria-current="page" aria-labelledby="nav-txt-chat"><span class="ico" aria-hidden="true">💬</span><span class="txt minhide" id="nav-txt-chat">对话</span></button>
      <button class="nav" data-view="board" aria-labelledby="nav-txt-board"><span class="ico" aria-hidden="true">🗒</span><span class="txt minhide" id="nav-txt-board">任务看板</span></button>
      <button class="nav" data-view="cognitive" aria-labelledby="nav-txt-cognitive"><span class="ico" aria-hidden="true">🧠</span><span class="txt minhide" id="nav-txt-cognitive">认知面板</span></button>
      <button class="nav" data-view="devices" aria-labelledby="nav-txt-devices"><span class="ico" aria-hidden="true">📟</span><span class="txt minhide" id="nav-txt-devices">设备</span></button>
      <button class="nav" data-view="ssh" aria-labelledby="nav-txt-ssh"><span class="ico" aria-hidden="true">🖧</span><span class="txt minhide" id="nav-txt-ssh">SSH</span></button>
      <button class="nav" data-view="skills" aria-labelledby="nav-txt-skills"><span class="ico" aria-hidden="true">📚</span><span class="txt minhide" id="nav-txt-skills">技能中心</span></button>
      <button class="nav" data-view="settings" aria-labelledby="nav-txt-settings"><span class="ico" aria-hidden="true">⚙️</span><span class="txt minhide" id="nav-txt-settings">设置</span></button>
      <button class="nav" data-view="label" aria-labelledby="nav-txt-label"><span class="ico" aria-hidden="true">⭐</span><span class="txt minhide" id="nav-txt-label">RL 标注</span></button>
    </nav>
    <div class="wshead"><span class="minhide" id="ws-label">工作区</span><span class="wsacts minhide"><button id="ws-refresh" type="button" title="刷新会话列表" aria-label="刷新会话列表">↻</button><button id="ws-open" type="button" title="在文件管理器中打开工作区" aria-label="在文件管理器中打开工作区">📂</button><button id="ws-new" type="button" title="添加工作区" aria-label="添加工作区">＋</button></span></div>
    <div id="wsbox" class="minhide">
      <button id="wscur" type="button" title="切换工作区" aria-label="切换工作区" aria-expanded="false" aria-controls="wslist"><span class="tri" aria-hidden="true">▾</span><span id="wscur-name">…</span></button>
      <div id="wslist">
        <div id="ws-items"></div>
        <button type="button" class="wsadd" id="ws-add">＋ 添加工作区</button>
      </div>
    </div>
    <input id="search" class="minhide" placeholder="搜索会话…" aria-label="搜索会话…">
    <div id="sesslist"><div class="grp" id="ph-sessions">最近会话</div><div id="sessions"></div><div class="grp" id="ph-other" style="display:none">其他 / 未分组</div><div id="sessions-other" style="display:none"></div></div>
    <div id="sidefoot" class="minhide"><span id="skills-n">0</span> <span id="skills-label">技能</span> · <span id="model2"></span></div>
  </aside>
  <main id="main" style="position:relative;">
    <h1 class="visually-hidden" id="app-title">hmh web</h1>
    <div id="topbar">
      <span class="modelwrap" style="position:relative"><button type="button" class="chip model" id="model" title="切换模型" aria-haspopup="true" aria-expanded="false" aria-controls="modelpick"></button></span>
      <button id="sideburger" type="button" title="会话列表" aria-label="会话列表">☰</button>
      <span class="chip" id="viewchip">对话</span>
      <span class="chip" id="home"></span>
      <button type="button" class="chip locale" id="locale-chip" aria-label="zh · 切换语言">zh</button>
      <button type="button" class="chip" id="goal-chip" aria-expanded="false" aria-controls="goalrow" style="display:none;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></button>
      <span class="chip" id="hud-chip" title="认知状态" style="display:none;gap:6px;font-family:var(--mono);font-size:11px"></span>
      <button id="theme-chip" type="button" class="ghost sm" title="theme" aria-label="切换主题">🌓</button>
      <span id="topspacer" style="margin-left:auto"></span>
      <span id="connchip" title="connection">⟳ 重连中…</span>
      <button id="phone-pair" type="button" title="📱 手机远程控制" aria-label="手机远程控制" style="display:none;background:none;border:1px solid var(--line);border-radius:7px;color:var(--text);cursor:pointer;font-size:15px;padding:3px 9px">📱</button>
      <button id="clear" type="button" class="ghost sm">clear</button>
    </div>
    <div id="view-chat" class="vwrap on">
      <div id="goalrow" style="display:none;margin:8px 16px 0;gap:6px;align-items:center;max-width:640px"><input id="goal-input" aria-label="会话目标" style="flex:1;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:4px 8px;font:12px inherit" placeholder=""><button id="goal-set" type="button" class="ghost sm" aria-label="保存目标">✓</button><button id="goal-clear" type="button" class="ghost sm" aria-label="清除目标">✕</button></div>
      <div id="plancard" style="display:none"><div class="phead"><span aria-hidden="true">▦</span><span id="plancard-title"></span><span style="margin-left:auto;color:var(--dim)" aria-hidden="true">▲</span></div><div class="psteps" id="plancard-steps"></div></div>
      <div id="log"><div id="empty"><div style="font-size:30px" aria-hidden="true">⚙️</div><div id="empty-title" style="margin:8px 0 4px;font-size:16px">给 hmh 一个任务</div><div id="empty-sub" style="font-size:12.5px">流式输出 · 浏览器审批 · 全程审计</div><div style="margin-top:14px"></div><button type="button" class="ex" data-ex="运行鸿蒙工具链体检并逐项总结">运行鸿蒙工具链体检并逐项总结</button><button type="button" class="ex" data-ex="列出已连接的设备和模拟器">列出已连接的设备和模拟器</button><button type="button" class="ex" data-ex="扫描开源鸿蒙生态雷达并总结简报">扫描开源鸿蒙生态雷达并总结简报</button></div></div>
      <button id="tobot" type="button" class="ghost sm" aria-label="回到底部">↓</button>
      <div id="composer">
        <div id="runstatus"><span id="rs-spin" aria-hidden="true">✻</span><span id="rs-text"></span><span id="rs-phase" style="margin-left:auto;font-family:var(--mono);font-size:11.5px"></span></div>
        <div id="queuebar"></div>
        <div id="approval" role="group" aria-labelledby="approval-req-label">
          <div><span id="approval-req-label">审批请求:</span><span class="name" id="ap-name"></span> <span id="ap-args" class="dim" style="font-family:var(--mono);color:var(--dim)"></span></div>
          <div id="ap-meta" style="margin-top:4px"></div>
          <div style="margin-top:8px"><button id="ap-yes" type="button" class="primary sm">批准</button> <button id="ap-no" type="button" class="danger sm">拒绝</button></div>
        </div>
        <div id="slashpanel"></div>
        <div id="atpanel"></div>
        <div id="attbar"></div>
        <input type="file" id="imgfile" accept="image/png,image/jpeg,image/webp" multiple style="display:none">
        <div id="inputcard">
          <textarea id="input" aria-label="任务输入框" placeholder="给 hmh 一个任务… (Enter 发送, Shift+Enter 换行)"></textarea>
          <div id="tools-row">
          <button id="attach" type="button" title="粘贴或选择图片附件" aria-label="添加图片附件">📎</button>
          <div style="position:relative">
          <select id="mode" title="approval mode" aria-label="审批模式">
            <option value="ask">🔒 审批询问</option>
            <option value="auto">⚡ 自动批准</option>
            <option value="yolo">🔥 YOLO</option>
          </select>
          <button id="preset-btn" type="button" class="ghost sm" title="权限预设" aria-label="权限预设" aria-expanded="false" aria-controls="presetpop">▾</button>
          <div id="presetpop">
            <button type="button" class="preset" data-mode="ask"><span class="pt">🔒 审批询问</span><div class="pd">每步危险操作都弹审批,逐步确认</div></button>
            <button type="button" class="preset" data-mode="auto"><span class="pt">⚡ 自动批准</span><div class="pd">常规操作自动放行,破坏性命令仍硬拒</div></button>
            <button type="button" class="preset" data-mode="yolo"><span class="pt">🔥 YOLO</span><div class="pd">完全无人值守,危险命令仍硬拒</div></button>
          </div>
          </div>
            <span id="tokchip"></span>
            <button id="send" type="button" class="primary">运行</button>
          </div>
        </div>
      </div>
    </div>
    <div id="view-board" class="view">
      <div class="vhead"><h2 id="board-title">任务看板</h2><button id="board-refresh" class="ghost sm">↻ 刷新</button></div>
      <div id="board-grid" class="bgrid"></div>
    </div>
    <div id="view-cognitive" class="view">
      <div class="vhead"><h2 id="cog-title">🧠 认知面板</h2><button id="cog-refresh" class="ghost sm">↻ 刷新</button></div>
      <div id="cog-body">
        <div class="setbox"><h3 class="sec">五层记忆</h3><div id="cog-memory" class="hint">加载中…</div></div>
        <div class="setbox"><h3 class="sec">世界模型（轨迹回放）</h3><div id="cog-world" class="hint">加载中…</div></div>
        <div class="setbox"><h3 class="sec">校准报告（实证价值所在）</h3><div id="cog-calib" class="hint">加载中…</div></div>
        <div class="setbox"><h3 class="sec">目标漂移检测</h3><div id="cog-drift" class="hint">加载中…</div></div>
        <div class="setbox"><h3 class="sec">技能候选（历史挖掘）</h3><div id="cog-skills" class="hint">加载中…</div></div>
        <div class="setbox"><h3 class="sec">多智能体（治理审计）</h3><div id="cog-team" class="hint">加载中…</div></div>
        <div class="setbox"><h3 class="sec">迁移矩阵（对照实验）</h3><div id="cog-transfer" class="hint">加载中…</div></div>
        <div class="setbox"><h3 class="sec">轨迹回放（RD-010）</h3><div id="cog-replay" class="hint">加载中…</div></div>
        <div class="setbox"><h3 class="sec">轨迹库（Episodic）</h3><div id="cog-traj" class="hint">加载中…</div></div>
        <div class="setbox"><h3 class="sec">进化审计（不可变）</h3><div id="cog-audit" class="hint">加载中…</div></div>
        <div class="setbox"><h3 class="sec">环境注册表</h3><div id="cog-env" class="hint">加载中…</div></div>
      </div>
    </div>
    <div id="view-devices" class="view">
      <div class="vhead"><h2 id="dev-title">设备</h2><button id="dev-refresh" class="ghost sm">↻ 刷新</button></div>
      <div id="dev-body"></div>
    </div>
    <div id="view-ssh" class="view">
      <div class="vhead"><h2 id="ssh-title">SSH</h2><button id="ssh-refresh" class="ghost sm">↻ 刷新</button></div>
      <div id="ssh-body">
        <div id="ssh-empty" class="hint">未配置 SSH 主机 — 在 config.json 添加 sshHosts({name,host,user,port,keyPath}) 后刷新</div>
        <div id="ssh-panels"></div>
      </div>
    </div>
    <div id="view-skills" class="view">
      <div class="vhead"><h2 id="sk-title">技能中心</h2></div>
      <div id="sk-body"></div>
    </div>
    <div id="view-settings" class="view">
      <div class="vhead"><h2 id="set-title">设置</h2></div>
      <div class="setbox" id="set-model">
        <h3 class="sec" id="set-model-title">模型 / Providers</h3>
        <div id="prov-list"></div>
        <button id="prov-add" class="ghost sm">＋ 新增 provider</button>
        <h3 class="sec" id="set-presets-title">内置预设（一键添加）</h3>
        <div id="prov-presets" class="presetgrid"></div>
      </div>
      <div class="setbox" id="set-general">
        <h3 class="sec" id="set-general-title">常规</h3>
        <div class="setrow"><label for="set-locale" id="set-locale-label">语言 locale</label><select id="set-locale"><option value="zh">中文</option><option value="en">English</option></select></div>
        <div class="setrow"><label for="set-approval" id="set-approval-label">默认审批模式</label><select id="set-approval"><option value="ask">🔒 ask（询问）</option><option value="auto">⚡ auto（自动放行）</option></select></div>
        <div class="setrow"><label for="set-evolve" id="set-evolve-label">自动进化间隔 autoEvolveEvery（0=关闭）</label><input id="set-evolve" type="number" min="0" max="100"></div>
        <div class="setrow"><label for="set-patch" id="set-patch-label">代码级自进化 evolution.autoPatch（危险）</label><input id="set-patch" type="checkbox"></div>
        <div style="margin-top:10px"><button id="set-save" type="button" class="primary sm">保存</button><span id="set-msg" role="status"></span></div>
      </div>
    </div>
    <div id="view-label" class="view">
      <div class="vhead"><h2 id="label-title">RL 标注</h2></div>
      <div id="label-prog" style="margin:0 0 10px;font-size:12.5px;color:var(--dim)"></div>
      <div id="label-hint" style="margin:0 0 12px;font-size:12px;color:var(--dim)"></div>
      <div id="label-body"></div>
    </div>
  </main>
  <aside id="rightbar" aria-label="会话详情">
    <div id="rdrag"></div>
    <div id="rhead">
      <div id="rtabs" role="tablist" aria-label="详情标签页">
        <button type="button" class="rtab on" role="tab" data-tab="detail" id="rtab-detail" aria-controls="rtab-detail-pane" aria-selected="true">详情</button>
        <button type="button" class="rtab" role="tab" data-tab="files" id="rtab-files" aria-controls="rtab-files-pane" aria-selected="false" tabindex="-1">文件</button>
        <button type="button" class="rtab" role="tab" data-tab="preview" id="rtab-preview" aria-controls="rtab-preview-pane" aria-selected="false" tabindex="-1">预览</button>
        <button type="button" class="rtab" role="tab" data-tab="evidence" id="rtab-evidence" aria-controls="rtab-evidence-pane" aria-selected="false" tabindex="-1">证据</button>
        <button type="button" class="rtab" role="tab" data-tab="logs" id="rtab-logs" aria-controls="rtab-logs-pane" aria-selected="false" tabindex="-1">日志</button>
      </div>
      <button id="rcollapse" type="button" class="ghost sm" title="折叠右栏" aria-label="折叠右栏" style="margin-left:auto">»</button>
      <button id="rclose" type="button" class="ghost sm" title="关闭右栏" aria-label="关闭右栏">✕</button>
    </div>
    <div id="rbody">
      <div id="rtab-detail-pane" class="rtabpane on" role="tabpanel" aria-labelledby="rtab-detail" tabindex="0">
        <div id="dname"></div>
        <div id="dbody"><div id="dempty">点击对话流中的工具行查看详情</div></div>
      </div>
      <div id="rtab-files-pane" class="rtabpane" role="tabpanel" aria-labelledby="rtab-files" tabindex="0">
        <div id="ftree"></div>
      </div>
      <div id="rtab-preview-pane" class="rtabpane" role="tabpanel" aria-labelledby="rtab-preview" tabindex="0">
        <div id="pview"><div class="hint" style="padding:10px">在文件树或对话中点击文件路径在此预览</div></div>
      </div>
      <div id="rtab-evidence-pane" class="rtabpane" role="tabpanel" aria-labelledby="rtab-evidence" tabindex="0">
        <div id="eview" style="padding:10px;font-size:12px;color:var(--dim)">当前会话的认知谱系：模型、世界模型版本、技能快照、证据链</div>
      </div>
      <div id="rtab-logs-pane" class="rtabpane" role="tabpanel" aria-labelledby="rtab-logs" tabindex="0">
        <div id="lview" style="padding:10px;font-size:11.5px;font-family:var(--mono);color:var(--dim);overflow:auto">暂无日志</div>
      </div>
    </div>
  </aside>
  <div id="wspick" role="dialog" aria-modal="true" aria-labelledby="wsp-title">
    <div id="wsp-card">
      <div id="wsp-head"><span id="wsp-title">选择工作区目录</span><button id="wsp-close" type="button" aria-label="关闭">✕</button></div>
      <input id="wsp-path" aria-label="或直接输入绝对路径, 回车前往" placeholder="或直接输入绝对路径, 回车前往">
      <div id="wsp-crumb"></div>
      <div id="wsp-list"></div>
      <div id="wsp-foot">
        <span id="wsp-sel"></span>
        <input id="wsp-name" aria-label="名称(默认目录名)" placeholder="名称(默认目录名)">
        <button id="wsp-cancel" type="button" class="ghost sm">取消</button>
        <button id="wsp-ok" type="button" class="primary sm">添加</button>
      </div>
    </div>
  </div>
  <div id="cmdpal" role="dialog" aria-modal="true" aria-label="命令面板">
    <div class="card">
      <input id="cmdpal-in" aria-label="搜索命令、视图或会话" placeholder="命令 / 视图 / 会话…">
      <div class="list" id="cmdpal-list"></div>
      <div class="foot">↑↓ 选择 · Enter 执行 · Esc 关闭</div>
    </div>
  </div>
  <div id="pairmod" role="dialog" aria-modal="true" aria-labelledby="pair-title">
    <div class="card">
      <h3 id="pair-title">📱 连接手机</h3>
      <div style="display:flex;gap:6px;margin:4px 0">
        <button id="pair-lan" type="button" class="ghost sm" aria-pressed="true" style="font-weight:600">🏠 WiFi 连接</button>
        <button id="pair-wan" type="button" class="ghost sm" aria-pressed="false" style="font-weight:600">🌐 互联网连接</button>
      </div>
      <div class="qr" id="pair-qrbox"><img id="pair-qr" alt="配对二维码"></div>
      <div class="pin" id="pair-pin" style="display:none">—</div>
      <div class="pinlab" id="pair-pinlab" style="display:none;font-size:11px;color:var(--dim)">配对密码（互联网模式，输入到手机）</div>
      <div class="url" id="pair-url">—</div>
      <div class="hint" id="pair-hint">手机扫码即可连接</div>
      <div class="hint" id="pair-count" style="color:var(--accent)">—</div>
      <div style="display:flex;gap:6px">
        <button id="pair-copy" class="ghost sm">复制链接</button>
        <button id="pair-line" class="ghost sm" style="display:none">换一条线路</button>
        <button id="pair-close" class="ghost sm">关闭</button>
      </div>
    </div>
  </div>
</div>
<style>
  button.primary { background:var(--accent); color:#08243a; border:0; border-radius:8px; padding:7px 16px; font-weight:600; cursor:pointer; }
  button.ghost { background:transparent; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:7px 14px; cursor:pointer; }
  button.ghost.sm, button.primary.sm { padding:3px 10px; font-size:12px; }
  button.danger { background:var(--err); color:#fff; border:0; border-radius:8px; padding:7px 14px; cursor:pointer; }
  button:disabled { opacity:.45; cursor:default; }
</style>
<script nonce="__HMH_NONCE__">
`;
