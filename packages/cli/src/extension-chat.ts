/**
 * @hmharness/cli - extension chat brain (round 45)
 *
 * The other end of the browser-side chat panel: a compact tool-loop agent
 * turn that reads/acts on the user's CURRENT tab through the live bridge and
 * answers with the user's configured provider (routing 'chat' — the same
 * one the web UI and CLI agent use). One HTTP request = one turn; the
 * transcript between turns lives in the bridge (in-memory).
 */
import { loadConfig, resolveProvider, chat, type ChatMessage, type ProviderConfig } from '@hmharness/kernel';
import type { ChatTurnInput, PageAct } from '@hmharness/extension';

/** OpenAI-style function schemas the model sees. Structured args only —
 *  no script text ever crosses this boundary (same rule as page.act). */
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'page_read',
      description: '读取用户当前浏览器标签页:标题、URL 与正文文本的精简提取。回答任何关于"这个页面/当前页"的问题前先调用它。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'page_act',
      description: '操作用户当前标签页(click 点击 / type 输入 / scroll 滚动 / select 选择)。动作会在用户眼前执行;不确定时先用 page_read 看页面、再问用户。',
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
] as const;

export interface ChatBrainDeps {
  readPage: () => Promise<unknown>;
  act: (act: PageAct) => Promise<unknown>;
  /** audit line sink — page_act is user-visible but still logged */
  log?: (line: string) => void;
}

const MAX_ROUNDS = 6;

function systemPrompt(input: ChatTurnInput): string {
  const lines = [
    '你是 hmharness 浏览器助手,直接在用户浏览器侧栏的对话面板里工作。用简洁中文回答。',
    '工具:page_read 读取用户当前浏览的页面;page_act 操作该页面。页面类问题先 page_read 再答。',
  ];
  if (input.page?.url) lines.push(`用户当前标签页: ${input.page.title ?? '(无标题)'} — ${input.page.url}`);
  return lines.join('\n');
}

/** Run ONE conversational turn (message + history → reply string). */
export async function answerChatTurn(input: ChatTurnInput, deps: ChatBrainDeps): Promise<string> {
  const cfg = await loadConfig();
  const provider = resolveProvider(cfg, 'chat');
  if (!provider?.apiKey) throw new Error('尚未配置 LLM provider — 在网页端设置或运行 hmh web 设置密钥后重试');
  return runChatTurn(provider, input, deps, chat);
}

/** The tool loop, separated so tests can inject a fake chat implementation. */
export async function runChatTurn(
  provider: ProviderConfig,
  input: ChatTurnInput,
  deps: ChatBrainDeps,
  chatImpl: typeof chat,
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(input) },
    ...input.history.map((t): ChatMessage => ({ role: t.role, content: t.content })),
    { role: 'user', content: input.message },
  ];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await chatImpl(provider, messages, [...TOOLS], { timeoutMs: 120_000, retry: { attempts: 2 } });
    const calls = res.message.tool_calls ?? [];
    if (!calls.length) return res.message.content?.trim() || '(模型返回了空回复)';
    messages.push(res.message);
    for (const call of calls) {
      let result: string;
      try {
        const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        if (call.function.name === 'page_read') {
          result = JSON.stringify(await deps.readPage()).slice(0, 12_000);
        } else if (call.function.name === 'page_act') {
          deps.log?.(`侧栏对话触发页面操作: ${JSON.stringify(args)}`);
          result = JSON.stringify(await deps.act(args as unknown as PageAct)).slice(0, 4_000);
        } else {
          result = JSON.stringify({ ok: false, error: `unknown tool ${call.function.name}` });
        }
      } catch (err) {
        result = JSON.stringify({ ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 200) });
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }
  return '(这一轮工具调用太多,已停下 — 请换个问法,或稍后再试)';
}
