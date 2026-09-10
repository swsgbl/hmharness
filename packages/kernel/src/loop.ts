/**
 * @hmharness/kernel - loop
 * The agent loop: call the model, run the tools it asks for, feed results
 * back, repeat until it answers without tool calls or the turn budget is
 * spent. This is the "loop engineering" core - kept deliberately dull.
 * Tools marked needsApproval pause here for a caller-provided ask() gate;
 * no gate configured means deny (safe default). Between turns the
 * transcript is compacted against the context budget.
 */
import { compactMessages, compactWithDigest, transcriptChars } from './context.ts';
import { adaptiveContextChars, adaptiveMaxTurns } from './window.ts';
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
  /** Explicit transcript budget override (chars). Default: scales with the
   *  model's context window (window.ts registry / provider.contextWindow). */
  maxContextChars?: number;
  approval?: LoopApproval;
  events?: LoopEvents;
  /** Injectable model call (tests pass a fake; production uses provider.chat). */
  chatImpl?: typeof chat;
  /** Rolling digest hook (model-aware context engineering): when compaction
   *  evicts content, it is distilled into a persistent digest note instead
   *  of being dropped. Absent -> deterministic prune only. */
  summarizeContext?: (input: { previousDigest: string | null; evicted: string[] }) => Promise<string>;
  /** Hard total turn cap — the safety valve (default: 5x the adaptive soft limit, max 400). */
  maxTotalTurns?: number;
  /** Hard total token spend cap — prompt + completion combined (default: 10M). */
  maxTotalTokens?: number;
}): Promise<LoopResult> {
  const { provider, registry, ctx, events } = opts;
  const modelCall = opts.chatImpl ?? chat;
  // Soft limit: where the wrap-up nudge fires (adaptive to context window).
  const softTurnLimit = adaptiveMaxTurns(provider);
  // Hard limit: the actual safety valve. If the model is still calling tools
  // at the soft limit, we auto-continue — the loop only hard-stops here.
  const hardTurnLimit = opts.maxTotalTurns ?? Math.min(softTurnLimit * 5, 400);
  const hardTokenLimit = opts.maxTotalTokens ?? 10_000_000;
  const budget = opts.maxContextChars ?? adaptiveContextChars(provider);
  const working: ChatMessage[] = [...opts.messages];
  let toolUses = 0;
  const usage = { promptTokens: 0, completionTokens: 0 };
  const tools = registry.toOpenAITools();

  let wrapupSignaled = false;
  let turn = 0;
  let reason: 'final' | 'turn-valve' | 'token-valve' = 'final';

  // The loop runs until the model gives a final answer (no tool calls) OR a
  // safety valve fires. The old "maxTurns stop" is replaced by a soft
  // checkpoint: if the model is still actively working (calling tools) at
  // the soft limit, the loop auto-continues — long-running tasks feel
  // unlimited while the hard valves protect against runaway loops and cost.
  while (true) {
    turn++;
    if (turn > hardTurnLimit) { reason = 'turn-valve'; break; }
    if (usage.promptTokens + usage.completionTokens > hardTokenLimit) { reason = 'token-valve'; break; }

    const compacted = opts.summarizeContext
      ? await compactWithDigest(working, budget, opts.summarizeContext)
      : compactMessages(working, budget);

    // Context budget wrap-up signal: when usage crosses 80%, nudge the model
    // to wind down (Codex token_budget_context + DeepSeek 80% pressure).
    if (!wrapupSignaled && transcriptChars(compacted) > budget * 0.8) {
      wrapupSignaled = true;
      working.push({
        role: 'system',
        content: '[context budget] Context is running low. Wrap up the current task: summarize what was accomplished, suggest concrete next steps, and stop starting new sub-tasks.',
      });
    }

    // Soft turn checkpoint: at the adaptive limit, nudge to conclude — but
    // the model can keep working if it's mid-task (auto-continue).
    if (turn === softTurnLimit) {
      working.push({
        role: 'system',
        content: `[turn checkpoint] You have been working for ${turn} turns. If the task is substantially complete, give your final answer now. If not, continue — the turn limit has been lifted; work until done.`,
      });
    }

    const chatRes = await modelCall(provider, compacted, tools, {
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
    // Loop continues: the model was actively calling tools, so we keep going
    // (auto-continuation past the soft turn limit). Only the safety valves
    // (hardTurnLimit / hardTokenLimit) can stop us now.
  }

  // Safety valve fired
  const text = reason === 'turn-valve'
    ? `Safety turn limit reached (${turn - 1} turns, hard cap ${hardTurnLimit}). The session is preserved — send another message to continue with fresh limits.`
    : `Token budget limit reached (~${usage.promptTokens + usage.completionTokens} tokens, cap ${hardTokenLimit}). The session is preserved — send another message to continue.`;
  events?.onFinal?.(text, turn - 1);
  return { text, turns: turn - 1, toolUses, messages: working, usage };
}
