/**
 * @hmh/kernel - loop
 * The agent loop: call the model, run the tools it asks for, feed results
 * back, repeat until it answers without tool calls or the turn budget is
 * spent. This is the "loop engineering" core - kept deliberately dull.
 * Tools marked needsApproval pause here for a caller-provided ask() gate;
 * no gate configured means deny (safe default). Between turns the
 * transcript is compacted against the context budget.
 */
import { compactMessages } from './context.ts';
import type { ChatMessage, RegistryLike } from './loop-types.ts';
import { chat, type DeltaKind } from './provider.ts';
import type { ProviderConfig, ToolContext } from './types.ts';

export interface LoopEvents {
  onAssistant?(m: ChatMessage): void;
  onDelta?(kind: DeltaKind, chunk: string): void;
  onToolCall?(name: string, args: Record<string, unknown>): void;
  onToolResult?(name: string, output: string, isError: boolean): void;
  /** Called when a tool requested approval. granted=false means denied. */
  onApproval?(name: string, args: Record<string, unknown>, granted: boolean): void;
  onFinal?(text: string, turns: number): void;
}

export interface LoopApproval {
  ask(toolName: string, args: Record<string, unknown>): Promise<boolean>;
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
  maxContextChars?: number;
  approval?: LoopApproval;
  events?: LoopEvents;
}): Promise<LoopResult> {
  const { provider, registry, ctx, events } = opts;
  const maxTurns = opts.maxTurns ?? 25;
  const working: ChatMessage[] = [...opts.messages];
  let toolUses = 0;
  const tools = registry.toOpenAITools();

  for (let turn = 1; turn <= maxTurns; turn++) {
    const { message } = await chat(provider, compactMessages(working, opts.maxContextChars), tools, {
      onDelta: events?.onDelta,
    });
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
      let output = '';
      let isError = false;
      if (!tool) {
        output = `unknown tool: ${name}`;
        isError = true;
      } else {
        if (tool.needsApproval?.(args)) {
          // Safe default: with no gate wired in, risky tools are denied.
          const granted = opts.approval ? await opts.approval.ask(name, args) : false;
          events?.onApproval?.(name, args, granted);
          if (!granted) {
            output = 'User declined this action. Ask how to proceed or find a non-destructive alternative.';
            isError = true;
          }
        }
        if (!isError) {
          try {
            const r = await tool.execute(args, ctx);
            output = r.output;
            isError = r.isError === true;
          } catch (err) {
            output = String(err);
            isError = true;
          }
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
