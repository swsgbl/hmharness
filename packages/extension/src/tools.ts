/**
 * @hmharness/extension - agent tools (the extension_* family)
 *
 * The USER'S-BROWSER counterpart of @hmharness/browser's browser_* family:
 * browser_* drives hmh's OWN dedicated BrowserOS instance over CDP;
 * extension_* sees (and, with per-use approval, acts in) the user's REAL
 * browser tabs through the paired extension. Both families can coexist.
 *
 * Registration follows the dead-tools rule: the runner registers these
 * ONLY when the bridge state file says an extension is connected RIGHT
 * NOW. Every execute re-derives the binding from the state file — a
 * bridge that died between registry build and tool call gets an honest
 * error, not a hang.
 *
 * extension_page_act ALWAYS needsApproval: it clicks/types in the user's
 * real browser, under their logins — no persistent rule can pre-approve
 * it (makeApproval's saved rules are keyed by tool name, but this tool
 * overrides needsApproval to force the gate every single time).
 */
import type { Tool } from '@hmharness/kernel';
import type { PageAct, RawPageData, TabInfo } from './protocol.ts';
import { agentCommand, bridgeFromState, type BridgeHandle } from './client.ts';
import { isPaired } from './token.ts';
import { discoverExtensionBridge } from './registry.ts';
import { formatPageSnapshot, summarizePage } from './page.ts';

export interface ExtensionToolContext {
  /** HMH_HOME — where the bridge state file lives */
  home: string;
}

const WRAP = (err: unknown): { output: string; isError: boolean } => ({
  output: String(err instanceof Error ? err.message : err).slice(0, 400),
  isError: true,
});

/** Bind to the running bridge or fail with the exact next step. */
function ensure(ctx: ExtensionToolContext): BridgeHandle {
  const handle = bridgeFromState(ctx.home);
  if (!handle) {
    throw new Error('hmh 扩展桥未运行 — 终端执行 hmh extension serve,再在浏览器扩展 popup 里配对连接');
  }
  return handle;
}

async function ensureConnected(ctx: ExtensionToolContext): Promise<BridgeHandle> {
  const handle = ensure(ctx);
  const probe = await discoverExtensionBridge(handle.port);
  if (!probe.healthy) throw new Error(`桥 ${handle.port} 端口已失联 — hmh extension serve 重启后再试`);
  if (!probe.connected) throw new Error('扩展当前未连接（浏览器重启/断网?）— 打开扩展 popup 重新连接后重试');
  return handle;
}

export function extensionTools(ctx: ExtensionToolContext): Tool[] {
  return [
    {
      name: 'extension_status',
      description: 'hmh 浏览器扩展桥的状态:桥是否运行、是否已配对、扩展是否连接、目标浏览器。排查 extension_* 工具问题时先调用这个。',
      parameters: { type: 'object', properties: {} },
      async execute() {
        try {
          const handle = ensure(ctx);
          const probe = await discoverExtensionBridge(handle.port);
          const paired = await isPaired(ctx.home);
          const lines = [
            `桥: 127.0.0.1:${probe.port} ${probe.healthy ? '运行中' : '失联'}`,
            `配对: ${paired ? '已配对' : '未配对(hmh extension pair)'}`,
            `扩展: ${probe.connected ? `已连接${probe.browser ? ' · ' + probe.browser : ''}${probe.extVersion ? ' v' + probe.extVersion : ''}` : '未连接(浏览器扩展 popup 里连接)'}`,
          ];
          return { output: lines.join('\n') };
        } catch (err) { return WRAP(err); }
      },
    },
    {
      name: 'extension_tabs',
      description: '列出用户真实浏览器当前打开的标签页(标题/URL/是否活动)。只读。与 browser_tabs(专用实例)不同,这里看到的是用户日常浏览器里的真实标签页。',
      parameters: { type: 'object', properties: {} },
      async execute() {
        try {
          const handle = await ensureConnected(ctx);
          const tabs = await agentCommand<TabInfo[]>(handle, { kind: 'tabs.list' });
          if (!Array.isArray(tabs) || tabs.length === 0) return { output: '(没有打开的标签页)' };
          return {
            output: `${tabs.length} 个标签页\n` + tabs
              .map((t) => `  [${t.id}]${t.active ? ' *活动*' : ''} ${String(t.title).slice(0, 60)} — ${String(t.url).slice(0, 100)}`)
              .join('\n'),
          };
        } catch (err) { return WRAP(err); }
      },
    },
    {
      name: 'extension_page_read',
      description: '读取用户真实浏览器某个标签页的内容(标题/URL/用户选区/标题大纲/表单/链接/正文,只读,约8k字符上限)。tabId 省略时读活动标签页。受保护页面(chrome:// 等)或未授权站点会诚实报错。对布局/视觉问题用 browser_screenshot 类工具,不要用这个。',
      parameters: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'extension_tabs 列出的标签页 id;省略 = 活动标签页' },
        },
      },
      async execute(args) {
        try {
          const handle = await ensureConnected(ctx);
          const raw = await agentCommand<RawPageData>(handle, {
            kind: 'page.read',
            ...(Number.isInteger(args.tabId) ? { tabId: Number(args.tabId) } : {}),
          });
          if (!raw || typeof raw.url !== 'string') return { output: '扩展返回的页面数据不完整(受保护页面?)', isError: true };
          return { output: formatPageSnapshot(summarizePage(raw)) };
        } catch (err) { return WRAP(err); }
      },
    },
    {
      name: 'extension_page_act',
      description: '在用户真实浏览器的标签页里执行一次页面操作:click(点击选择器)/type(输入文本,React 兼容)/scroll(滚动)/select(设置下拉值)。⚠️ 这会在用户真实浏览器、用户已登录的页面上动手 — 每次调用都必须获得用户批准。先 extension_page_read 看清页面再操作。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'click | type | scroll | select' },
          selector: { type: 'string', description: 'CSS 选择器(click/type/select 必填)' },
          text: { type: 'string', description: 'type 的文本 / select 的值' },
          direction: { type: 'string', description: 'scroll 方向: down(默认) | up | top | bottom' },
          tabId: { type: 'number', description: '目标标签页 id;省略 = 活动标签页' },
        },
        required: ['action'],
      },
      // 恒定审批:真实浏览器里的每一步都要用户点头 — 持久规则也不能豁免
      needsApproval: () => true,
      async execute(args) {
        try {
          const action = String(args.action ?? '');
          if (!['click', 'type', 'scroll', 'select'].includes(action)) {
            return { output: `action 必须是 click|type|scroll|select(收到 '${action}')`, isError: true };
          }
          if (action !== 'scroll' && !args.selector) {
            return { output: `${action} 需要 selector(CSS 选择器)`, isError: true };
          }
          const act: PageAct = {
            action: action as PageAct['action'],
            ...(args.selector ? { selector: String(args.selector) } : {}),
            ...(args.text !== undefined ? { text: String(args.text) } : {}),
            ...(args.direction ? { direction: String(args.direction) as PageAct['direction'] } : {}),
          };
          const handle = await ensureConnected(ctx);
          const r = await agentCommand<{ detail?: string }>(handle, {
            kind: 'page.act',
            act,
            ...(Number.isInteger(args.tabId) ? { tabId: Number(args.tabId) } : {}),
          });
          return { output: `已在用户浏览器执行 ${action}: ${r?.detail ?? 'ok'} — 建议 extension_page_read 复核结果` };
        } catch (err) { return WRAP(err); }
      },
    },
  ];
}
