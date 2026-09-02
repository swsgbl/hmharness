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
  /** The full working transcript (system + task + all turns), uncompacted. */
  messages: ChatMessage[];
  /** Token usage summed across all model calls in this run (when reported). */
  usage: { promptTokens: number; completionTokens: number };
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
  /** Injectable model call (tests pass a fake; production uses provider.chat). */
  chatImpl?: typeof chat;
}): Promise<LoopResult> {
  const { provider, registry, ctx, events } = opts;
  const modelCall = opts.chatImpl ?? chat;
  const maxTurns = opts.maxTurns ?? 25;
  const working: ChatMessage[] = [...opts.messages];
  let toolUses = 0;
  const usage = { promptTokens: 0, completionTokens: 0 };
  const tools = registry.toOpenAITools();

  for (let turn = 1; turn <= maxTurns; turn++) {
    const chatRes = await modelCall(provider, compactMessages(working, opts.maxContextChars), tools, {
      onDelta: events?.onDelta,
    });
    usage.promptTokens += chatRes.usage?.prompt_tokens ?? 0;
    usage.completionTokens += chatRes.usage?.completion_tokens ?? 0;
    const { message } = chatRes;
    events?.onAssistant?.(message);

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      const text = message.content ?? '';
      events?.onFinal?.(text, turn);
      return { text, turns: turn, toolUses, messages: working, usage };
    }

    working.push({ role: 'assistant', content: message.content ?? null, tool_calls: calls });

    // Two-phase execution: approvals are asked ONE AT A TIME (the gate is a
    // single dialog - ordering matters), then all approved tools run
    // CONCURRENTLY. Independent calls (fetches, builds, searches) no longer
    // serialize; this is the single biggest wall-clock win of the loop.
    interface Planned {
      call: (typeof calls)[number];
      name: string;
      args: Record<string, unknown>;
      output: string;
      isError: boolean;
      skip: boolean; // denied or invalid - never executed
    }
    const planned: Planned[] = [];
    for (const call of calls) {
      const name = call.function.name;
      let args: Record<string, unknown> = {};
      let badArgs = false;
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        badArgs = true;
      }
      events?.onToolCall?.(name, args);
      const tool = registry.get(name);
      const p: Planned = { call, name, args, output: '', isError: false, skip: false };
      if (!tool) {
        p.output = `unknown tool: ${name}`;
        p.isError = true;
        p.skip = true;
      } else if (badArgs) {
        p.output = `unparseable tool arguments for ${name}: ${call.function.arguments.slice(0, 200)}`;
        p.isError = true;
        p.skip = true;
      } else if (tool.needsApproval?.(args)) {
        // Safe default: with no gate wired in, risky tools are denied.
        const granted = opts.approval ? await opts.approval.ask(name, args) : false;
        events?.onApproval?.(name, args, granted);
        if (!granted) {
          p.output = 'User declined this action. Ask how to proceed or find a non-destructive alternative.';
          p.isError = true;
          p.skip = true;
        }
      }
      planned.push(p);
    }
    await Promise.all(planned.map(async (p) => {
      if (p.skip) return;
      try {
        const r = await registry.get(p.name)!.execute(p.args, ctx);
        p.output = r.output;
        p.isError = r.isError === true;
      } catch (err) {
        p.output = String(err);
        p.isError = true;
      }
    }));
    for (const p of planned) {
      toolUses++;
      events?.onToolResult?.(p.name, p.output, p.isError);
      working.push({
        role: 'tool',
        tool_call_id: p.call.id,
        name: p.name,
        content: p.output.length > 60_000 ? p.output.slice(0, 60_000) + '\n...[truncated]' : p.output,
      });
    }
  }
  const text = `Turn budget exhausted (${maxTurns}). Last state preserved in the session log.`;
  events?.onFinal?.(text, maxTurns);
  return { text, turns: maxTurns, toolUses, messages: working, usage };
}
