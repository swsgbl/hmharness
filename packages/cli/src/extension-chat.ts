/**
 * @hmharness/cli - extension chat brain (rounds 45/48/49)
 *
 * The other end of the browser-side chat panel: an agent turn that HAS the
 * current page (proactive pre-read, round 48) plus — when the serve process
 * wires them — navigation, tabs, workspace files and shell commands (round
 * 49: the user called the two-tool version "crippled"; this is the full
 * hmharness capability set, with a CONVERSATIONAL approval gate for the
 * dangerous ones: the model proposes, the user types 「确认」).
 */
import { loadConfig, resolveProvider, chat, type ChatMessage, type ProviderConfig } from '@hmharness/kernel';
import { formatPageSnapshot, summarizePage } from '@hmharness/extension';
import type { ChatTurnInput, PageAct } from '@hmharness/extension';

export interface ChatBrainDeps {
  readPage: () => Promise<unknown>;
  act: (act: PageAct) => Promise<unknown>;
  /** audit line sink — page_act and confirmed commands are logged */
  log?: (line: string) => void;
  // ---- round 49 extensions (all optional: absent = not advertised) ----
  /** navigate the user's active tab (http/https enforced both ends) */
  goto?: (url: string) => Promise<unknown>;
  listTabs?: () => Promise<unknown>;
  /** shell — ToolResult-shaped { output, isError? } from the agent's runCommandTool */
  runCommand?: (command: string, timeoutMs?: number) => Promise<unknown>;
  readFile?: (path: string) => Promise<unknown>;
  writeFile?: (path: string, content: string) => Promise<unknown>;
  listDir?: (path: string) => Promise<unknown>;
  /** the working directory commands/files resolve against (told to the model) */
  workspace?: string;
  /** LIVE activity feed (round 50): every step lands in the panel while it waits */
  step?: (line: string) => void;
}

/** tool result shape from the agent's tool singletons */
interface ToolOut { output: string; isError?: boolean }

/** round bound: the CLI's own maxTurns guard, floored at 50 for the sidebar
 *  (round 49: hand over a task, get it FINISHED — the panel auto-continues
 *  past the budget via the sentinel, so the floor only guards one HTTP
 *  request against infinite loops, never the task). */
const DEFAULT_MAX_ROUNDS = 50;

/** pending confirmation per chat origin: the model proposed, we wait for 「确认」 */
const pendingConfirm = new Map<string, { kind: 'run_command' | 'write_file'; summary: string; run: () => Promise<unknown> }>();
const CONFIRM_RE = /^(确认|确定|执行|同意|yes|ok)\s*$/i;

function baseTools(): Array<Record<string, unknown>> {
  return [
    {
      type: 'function',
      function: {
        name: 'page_read',
        description: '重新读取用户当前浏览器标签页(内容可能已变)。回答页面问题前若已附有自动读取的内容,先基于它回答。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'page_act',
        description: '操作用户当前标签页(click/type/scroll/select)。动作会在用户眼前执行;不确定时先 page_read 看页面、再问用户。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['click', 'type', 'scroll', 'select'] },
            selector: { type: 'string', description: '目标元素的 CSS 选择器' },
            text: { type: 'string', description: 'action=type 时要输入的文本' },
            direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'action=scroll 时的方向' },
          },
          required: ['action'],
        },
      },
    },
  ];
}

function extendedTools(deps: ChatBrainDeps): Array<Record<string, unknown>> {
  const tools = baseTools();
  if (deps.goto) {
    tools.push({
      type: 'function',
      function: {
        name: 'page_goto',
        description: '把用户当前标签页导航到指定网址(http/https)。页面打不开/需要换页面时直接用它,不要请用户手动开。',
        parameters: { type: 'object', properties: { url: { type: 'string', description: '完整网址,必须 http(s)://' } }, required: ['url'] },
      },
    });
  }
  if (deps.listTabs) {
    tools.push({
      type: 'function',
      function: {
        name: 'tabs_list',
        description: '列出用户浏览器当前打开的全部标签页。',
        parameters: { type: 'object', properties: {} },
      },
    });
  }
  if (deps.runCommand) {
    tools.push({
      type: 'function',
      function: {
        name: 'run_command',
        description: '在工作目录执行一条终端命令(npm/git 等)。危险操作会先征求用户确认——把确认提示原样转达给用户。',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string', description: '单行命令' }, timeout_ms: { type: 'number', description: '超时毫秒(默认 60000,最大 300000)' } },
          required: ['command'],
        },
      },
    });
  }
  if (deps.readFile) {
    tools.push({
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取工作目录中的文件内容。',
        parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' } }, required: ['path'] },
      },
    });
  }
  if (deps.listDir) {
    tools.push({
      type: 'function',
      function: {
        name: 'list_dir',
        description: '列出工作目录中某路径下的内容。',
        parameters: { type: 'object', properties: { path: { type: 'string', description: '目录路径(空 = 工作目录)' } }, required: ['path'] },
      },
    });
  }
  if (deps.writeFile) {
    tools.push({
      type: 'function',
      function: {
        name: 'write_file',
        description: '写入/覆盖工作目录中的文件。会先征求用户确认。',
        parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      },
    });
  }
  return tools;
}

function systemPrompt(input: ChatTurnInput, pageBlock: string, deps: ChatBrainDeps): string {
  const lines = [
    '你是 hmharness 智能体的浏览器侧栏形态,用简洁中文工作。',
    '页面能力:当前页面内容已自动附上;可用 page_read 重读、page_act 操作、page_goto 导航、tabs_list 列标签页。',
  ];
  if (deps.runCommand) {
    lines.push(`终端能力:工作目录 ${deps.workspace ?? '(serve 进程目录)'} 下可 run_command(执行命令)、read_file / write_file / list_dir(文件操作)。修改类与命令类操作需用户逐次确认——把确认提示原样转达,用户回复「确认」后才执行。`);
  } else {
    lines.push('本会话未接入终端/文件能力(仅页面能力)。');
  }
  lines.push('页面打不开时先 page_goto,不要请用户手动操作。回答基于证据;做不到就明说。');
  lines.push('任务策略:Dependabot/安全告警/CI 报错等通知类任务——邮件只是通知,病根在本地代码与依赖锁定文件里;直接用文件读写+命令在本地修复并 git 提交推送即可关闭远程告警,除非明确需要网页上的信息,否则不要去操作网页。');
  if (input.page?.url) lines.push(`用户当前标签页: ${input.page.title ?? '(无标题)'} — ${input.page.url}`);
  if (pageBlock) lines.push(pageBlock);
  return lines.join('\n');
}

/** PROACTIVE page context (round 48): read the user's current tab BEFORE the
 *  model runs, so even a tool-call-less model already HAS the page. A failed
 *  read becomes an honest note in the prompt, never a silent blank. */
/** PROACTIVE page context (round 48): read the user's current tab BEFORE the
 *  model runs, so even a tool-call-less model already HAS the page. A failed
 *  read becomes an honest note in the prompt, never a silent blank.
 *  Takes only the readPage sliver — the full brain deps are not needed. */
export async function readPageContext(deps: Pick<ChatBrainDeps, 'readPage'>): Promise<string> {
  try {
    const raw = await deps.readPage();
    if (!raw || typeof raw !== 'object') return '【当前页面】读取无结果(受保护页面或站点权限未授予)。';
    const text = formatPageSnapshot(summarizePage(raw as never)).slice(0, 6000);
    return `【当前页面 · 自动读取】\n${text}`;
  } catch (err) {
    return `【当前页面】自动读取失败: ${String(err instanceof Error ? err.message : err).slice(0, 150)}(浏览器内置页/受保护页面无法读取;可尝试 page_goto 到普通网页)`;
  }
}

/** Run ONE conversational turn (message + history → reply string). */
export async function answerChatTurn(input: ChatTurnInput, deps: ChatBrainDeps): Promise<string> {
  const cfg = await loadConfig();
  const provider = resolveProvider(cfg, 'chat');
  if (!provider?.apiKey) throw new Error('尚未配置 LLM provider — 在网页端设置或运行 hmh web 设置密钥后重试');
  const origin = input.origin ?? 'anon';

  // pending-confirmation gate (round 49): 「确认」 executes, anything else cancels
  const pending = pendingConfirm.get(origin);
  pendingConfirm.delete(origin);
  let executed = '';
  if (pending) {
    if (CONFIRM_RE.test(input.message.trim())) {
      try {
        const r = (await pending.run()) as ToolOut;
        deps.log?.(`侧栏确认执行: ${pending.summary}`);
        executed = `【已执行: ${pending.summary}】\n${String(r?.output ?? '').slice(0, 4000)}${r?.isError ? '\n(执行报错)' : ''}\n\n`;
      } catch (err) {
        executed = `【执行失败: ${pending.summary}】${String(err instanceof Error ? err.message : err).slice(0, 300)}\n\n`;
      }
    } else {
      executed = `【已取消: ${pending.summary}(用户未确认)】\n\n`;
    }
  }

  return runChatTurn(provider, { ...input, message: executed + input.message }, deps, chat, origin, Math.max(cfg.maxTurns ?? DEFAULT_MAX_ROUNDS, DEFAULT_MAX_ROUNDS));
}

/** The tool loop, separated so tests can inject a fake chat implementation. */
export async function runChatTurn(
  provider: ProviderConfig,
  input: ChatTurnInput,
  deps: ChatBrainDeps,
  chatImpl: typeof chat,
  origin = 'anon',
  maxRounds = DEFAULT_MAX_ROUNDS,
  wallClockMs = 360_000,
): Promise<string> {
  const t0 = Date.now();
  const step = (line: string) => { try { deps.step?.(line); } catch { /* feed is best-effort */ } };
  step('读取当前页面(预热)…');
  let pageFails = 0; // page-channel damper: a ghost extension turns every
  // page op into a full 20s timeout burn — after 3 consecutive failures the
  // channel short-circuits so the loop pivots instead of grinding invisibly
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(input, await readPageContext(deps), deps) },
    ...input.history.map((t): ChatMessage => ({ role: t.role, content: t.content })),
    { role: 'user', content: input.message },
  ];
  const tools = extendedTools(deps);
  step(`上下文就绪(工具 ${tools.length} 个,轮预算 ${maxRounds})`);
  for (let round = 0; round < maxRounds; round++) {
    // wall-clock bound (round 50): one REQUEST may not run forever — the
    // sentinel + panel chaining carry the TASK onward, each segment visible
    const outOfTime = Date.now() - t0 > wallClockMs;
    // LAST round (or out of time): strip tools so the model MUST wrap up in
    // prose — the user gets a real progress summary, not a code excuse
    const last = round === maxRounds - 1 || outOfTime;
    if (outOfTime) step('已达单段时限,收尾汇报…');
    step(`第 ${round + 1} 轮思考中…(已用 ${Math.round((Date.now() - t0) / 1000)}s)`);
    const res = await chatImpl(provider, messages, last ? [] : [...tools], { timeoutMs: 120_000, retry: { attempts: 2 } });
    const calls = last ? [] : res.message.tool_calls ?? [];
    if (!calls.length) {
      const text = res.message.content?.trim() || '(模型返回了空回复)';
      // AUTONOMOUS CONTINUATION (round 49): the task is not done, the round
      // budget is — the panel auto-sends 「继续」 when it sees this sentinel,
      // so the user hands over a task and gets it finished, no babysitting
      return last ? text + '\n[[hmh:auto-continue]]' : text;
    }
    step(`第 ${round + 1} 轮: ${calls.map((c) => c.function.name).join(', ')}`);
    messages.push(res.message);
    for (const call of calls) {
      let result: string;
      try {
        const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        if (pageFails >= 3 && (name => name === 'page_read' || name === 'page_act' || name === 'page_goto')(call.function.name)) {
          result = JSON.stringify({ ok: false, error: '页面通道连续失败(扩展断连?)——已熔断。请停止页面操作:基于已有信息回答,或让用户重连扩展后重试。' });
        } else {
          result = await dispatchTool(call.function.name, args, deps, origin, step);
          if (/^page_/.test(call.function.name) && result.includes('"error"')) pageFails++;
          else if (/^page_/.test(call.function.name)) pageFails = 0;
        }
      } catch (err) {
        result = JSON.stringify({ ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 200) });
        if (/^page_/.test(call.function.name)) pageFails++;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }
  return '[[hmh:auto-continue]]';
}

async function dispatchTool(name: string, args: Record<string, unknown>, deps: ChatBrainDeps, origin: string, step?: (line: string) => void): Promise<string> {
  const json = (v: unknown, cap = 12_000) => JSON.stringify(v).slice(0, cap);
  switch (name) {
    case 'page_read': {
      step?.('读取当前页面…');
      try {
        const r = await deps.readPage();
        step?.('页面读取完成');
        return json(r);
      } catch (e) {
        step?.('页面读取失败: ' + String(e instanceof Error ? e.message : e).slice(0, 80));
        throw e;
      }
    }
    case 'page_act': {
      step?.(`页面操作: ${String(args.action ?? '')} ${String(args.selector ?? args.direction ?? '').slice(0, 50)}`);
      deps.log?.(`侧栏对话触发页面操作: ${JSON.stringify(args)}`);
      return json(await deps.act(args as unknown as PageAct), 4_000);
    }
    case 'page_goto': {
      const url = String(args.url ?? '');
      if (!/^https?:\/\//i.test(url)) return JSON.stringify({ ok: false, error: 'page_goto 只允许 http/https 地址' });
      step?.(`导航: ${url.slice(0, 70)}`);
      deps.log?.(`侧栏导航: ${url}`);
      return json(await deps.goto!(url), 2_000);
    }
    case 'tabs_list':
      step?.('列出标签页…');
      return json(await deps.listTabs!(), 6_000);
    case 'run_command': {
      const command = String(args.command ?? '');
      step?.(`命令待确认: ${command.slice(0, 80)}`);
      // ALWAYS gated: turn N proposes (needConfirm) → user replies 「确认」 →
      // turn N+1's pre-loop executes it and injects 【已执行】. A model
      // re-calling the same command in one turn must NOT double-run it.
      pendingConfirm.set(origin, {
        kind: 'run_command',
        summary: command,
        run: () => deps.runCommand!(command, Number(args.timeout_ms)),
      });
      return JSON.stringify({ needConfirm: true, message: `即将在终端执行: ${command}`, hint: '转达给用户:回复「确认」执行,回复其他内容取消。若上方已有【已执行】记录,不要重复执行,直接使用其结果。' });
    }
    case 'write_file': {
      const path = String(args.path ?? '');
      const content = String(args.content ?? '');
      const summary = `write_file ${path}(${content.length} 字符)`;
      pendingConfirm.set(origin, {
        kind: 'write_file',
        summary,
        run: () => deps.writeFile!(path, content),
      });
      return JSON.stringify({ needConfirm: true, message: `即将写入文件: ${summary}`, hint: '转达给用户:回复「确认」执行,回复其他内容取消。' });
    }
    case 'read_file':
      step?.(`读取文件: ${String(args.path ?? '')}`);
      return JSON.stringify(await deps.readFile!(String(args.path ?? ''))).slice(0, 12_000);
    case 'list_dir':
      step?.(`列目录: ${String(args.path ?? '')}`);
      return json(await deps.listDir!(String(args.path ?? '')), 6_000);
    default:
      return JSON.stringify({ ok: false, error: `unknown tool ${name}` });
  }
}
