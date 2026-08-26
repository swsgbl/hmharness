/**
 * @hmh/kernel - loop
 * The agent loop: call the model, run the tools it asks for, feed results
 * back, repeat until it answers without tool calls or the turn budget is
 * spent. This is the "loop engineering" core - kept deliberately dull.
 */
import type { ChatMessage, RegistryLike } from './loop-types.ts';
import { chat } from './provider.ts';
import type { ProviderConfig, ToolContext } from './types.ts';

export interface LoopEvents {
  onAssistant?(m: ChatMessage): void;
  onToolCall?(name: string, args: Record<string, unknown>): void;
  onToolResult?(name: string, output: string, isError: boolean): void;
  onFinal?(text: string, turns: number): void;
}

export interface LoopResult {
  text: string;
  turns: number;
  toolUses: number;
}

export async function runLoop(opts: {
  provider: ProviderConfig;
  registry: RegistryLike;
  messages: ChatMessage[];
  ctx: ToolContext;
  maxTurns?: number;
  events?: LoopEvents;
}): Promise<LoopResult> {
  const { provider, registry, messages, ctx, events } = opts;
  const maxTurns = opts.maxTurns ?? 25;
  const working: ChatMessage[] = [...messages];
  const tools = registry.toOpenAITools();
  let toolUses = 0;

  for (let turn = 1; turn <= maxTurns; turn++) {
    const { message } = await chat(provider, working, tools);
    events?.onAssistant?.(message);

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      const text = message.content ?? '';
      events?.onFinal?.(text, turn);
      return { text, turns: turn, toolUses };
    }

    working.push({ role: 'assistant', content: message.content ?? null, tool_calls: calls });
    for (const call of calls) {
      const name = call.function.name;
      let args: Record<string, unknown> = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = {};
      }
      events?.onToolCall?.(name, args);
      const tool = registry.get(name);
      let output: string;
      let isError = false;
      if (!tool) {
        output = `unknown tool: ${name}`;
        isError = true;
      } else {
        try {
          const r = await tool.execute(args, ctx);
          output = r.output;
          isError = r.isError === true;
        } catch (err) {
          output = String(err);
          isError = true;
        }
      }
      toolUses++;
      events?.onToolResult?.(name, output, isError);
      working.push({
        role: 'tool',
        tool_call_id: call.id,
        name,
        content: output.length > 60_000 ? output.slice(0, 60_000) + '\n...[truncated]' : output,
      });
    }
  }
  const text = `Turn budget exhausted (${maxTurns}). Last state preserved in the session log.`;
  events?.onFinal?.(text, maxTurns);
  return { text, turns: maxTurns, toolUses };
}
