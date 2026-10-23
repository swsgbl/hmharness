/**
 * @hmharness/cli - extension chat via the REAL agent (round 52)
 *
 * The user's side-by-side verdict: the BrowserOS panel (hmh acp-serve) and
 * the extension sidebar were "the same hmh CLI AI" in name only — acp-serve
 * runs runAgentTask (full tool registry + the real system prompt with
 * memory/skills/insights + session continuity), while the sidebar was a
 * hand-rolled chat loop. This module converges them: one chat turn = one
 * runAgentTask on a per-origin SESSION (conversations continue like a real
 * agent thread), tools/events/approval wired:
 *   - events.onToolCall/onToolResult → the live activity feed
 *   - approvalAsk → the conversational confirm gate: deny now, record the
 *     exact call, the user's 「确认」 next turn executes it pre-loop and
 *     injects the result (identical contract to the compact brain)
 *   - proactive page context rides as task prefix (round 48 discipline)
 *   - wall-clock abort at the segment boundary → auto-continue sentinel
 */
import type { ChatTurnInput, PageAct } from '@hmharness/extension';
import { formatPageSnapshot, summarizePage } from '@hmharness/extension';
import type { Registry, Tool, ToolContext } from '@hmharness/kernel';

/** what serve injects: the agent machinery + the bridge page channel */
export interface AgentBrainEnv {
  buildRegistry: () => Promise<{ reg: Registry }>;
  /** native-only rebuild (no MCP servers) for the degraded path */
  buildRegistryNative?: () => Promise<{ reg: Registry }>;
  runAgentTask: (opts: Record<string, unknown>) => Promise<{ text: string; turns: number; toolUses: number; sessionId: string }>;
  ctx: ToolContext;
  /** bridge page channel: goto + proactive read (http/https enforced bridge-side) */
  goto: (url: string) => Promise<unknown>;
  readPage: () => Promise<unknown>;
  step: (line: string) => void;
  log?: (line: string) => void;
  /** per-request wall clock (tests inject milliseconds) */
  segmentMs?: number;
}

/** per-origin agent state: session id (conversation continuity) + the last
 *  approval the user was asked to confirm (name+args, executed on 「确认」) */
const sessions = new Map<string, string>();
const agentPending = new Map<string, { name: string; args: Record<string, unknown>; summary: string; reg: Registry; ctx: ToolContext }>();
const CONFIRM_RE = /^(确认|确定|执行|同意|yes|ok)\s*$/i;
const SEGMENT_MS = 360_000;

const pageGotoTool = (goto: (url: string) => Promise<unknown>): Tool => ({
  name: 'page_goto',
  description: '把用户浏览器当前标签页导航到指定网址(http/https)。需要换页面时直接用。',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: '完整网址,必须 http(s)://' } },
    required: ['url'],
  },
  async execute(args) {
    const url = String(args.url ?? '');
    if (!/^https?:\/\//i.test(url)) return { output: 'page_goto 只允许 http/https 地址', isError: true };
    return { output: JSON.stringify(await goto(url)).slice(0, 2000) };
  },
});

async function pageContext(env: AgentBrainEnv): Promise<string> {
  try {
    const raw = await env.readPage();
    if (!raw || typeof raw !== 'object') return '';
    return `\n\n【用户当前浏览器页面 · 自动附上】\n${formatPageSnapshot(summarizePage(raw as never)).slice(0, 6000)}`;
  } catch {
    return ''; // proactive context is a bonus, never a blocker
  }
}

/** One chat turn = one real agent task on the origin's session. */
export async function answerWithAgentTurn(input: ChatTurnInput, env: AgentBrainEnv): Promise<string> {
  const origin = input.origin ?? 'anon';
  env.step('组装工具注册表…');
  let reg: Registry;
  try {
    reg = (await Promise.race([
      env.buildRegistry(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('registry build timeout (30s)')), 30_000)),
    ])).reg;
  } catch (err) {
    // a dead/slow MCP server must not black-hole the FIRST turn of a fresh
    // daemon (field-caught round 53: 888s of silence before any step) —
    // degrade to the native registry (everything except MCP tools)
    env.step(`注册表组装超时——降级为原生工具集(不含 MCP)`);
    if (!env.buildRegistryNative) throw err;
    reg = (await Promise.race([
      env.buildRegistryNative(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('native fallback timeout')), 15_000)),
    ])).reg;
  }
  env.step('注册表就绪');
  // the bridge page channel joins the real registry (idempotent by name)
  try { reg.register(pageGotoTool(env.goto)); } catch { /* already there */ }

  // resolve last turn's pending approval: 「确认」 executes it pre-loop
  let prefix = '';
  const pending = agentPending.get(origin);
  agentPending.delete(origin);
  if (pending) {
    if (CONFIRM_RE.test(input.message.trim())) {
      env.step(`确认执行: ${pending.summary}`);
      env.log?.(`侧栏确认执行(agent): ${pending.summary}`);
      try {
        const r = await pending.reg.get(pending.name)?.execute(pending.args, pending.ctx);
        prefix = `【已执行: ${pending.summary}】\n${String((r as { output?: string })?.output ?? '').slice(0, 4000)}\n\n`;
      } catch (err) {
        prefix = `【执行失败: ${pending.summary}】${String(err instanceof Error ? err.message : err).slice(0, 300)}\n\n`;
      }
    } else {
      prefix = `【已取消: ${pending.summary}(用户未确认)】\n\n`;
    }
  }

  const task = `${prefix}${input.message}${await pageContext(env)}`;
  const sessionId = sessions.get(origin);
  const ac = new AbortController();
  const bail = setTimeout(() => { try { ac.abort(); } catch { /* gone */ } }, env.segmentMs ?? SEGMENT_MS);
  try {
    const r = await env.runAgentTask({
      task,
      registry: reg,
      ctx: env.ctx,
      ...(sessionId ? { sessionId } : {}),
      signal: ac.signal,
      events: {
        onToolCall: (name: string, args: Record<string, unknown>) => env.step(`工具 ${name}: ${JSON.stringify(args).slice(0, 80)}`),
        onToolResult: (name: string, output: string, isError: boolean) => env.step(isError ? `${name} 失败: ${output.slice(0, 80)}` : `${name} 完成`),
      },
      approvalAsk: async (name: string, args: Record<string, unknown>) => {
        const summary = `${name} ${JSON.stringify(args).slice(0, 100)}`;
        agentPending.set(origin, { name, args, summary, reg, ctx: env.ctx });
        env.step(`待确认: ${summary}`);
        return false; // the model relays the ask; 「确认」 executes next turn
      },
    });
    sessions.set(origin, r.sessionId);
    return r.text?.trim() || '(模型返回了空回复)';
  } catch (err) {
    if (ac.signal.aborted) return '(这一段到达时间边界,已收尾——任务未完,自动继续。)\n[[hmh:auto-continue]]';
    throw err;
  } finally {
    clearTimeout(bail);
  }
}

/** the compact fallback path stays for brain-less/agent-less environments */
export type CompactDeps = {
  readPage: () => Promise<unknown>;
  act: (act: PageAct) => Promise<unknown>;
};
