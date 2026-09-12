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
  /** Why the loop stopped: final answer, idle detection, a safety valve, or
   *  user interrupt - trajectory outcomes (M1) and UI labels consume it. */
  reason: 'final' | 'idle' | 'turn-valve' | 'token-valve' | 'interrupted';
}

export async function runLoop(opts: {
  provider: ProviderConfig;
  registry: RegistryLike;
  messages: ChatMessage[];
  ctx: ToolContext;
  maxTurns?: number;
  /** AbortSignal: when fired, the loop stops at the next turn boundary and
   *  returns with reason "interrupted". Use for user-initiated cancellation
   *  (Esc key, /queue skip, web API interrupt). */
  signal?: AbortSignal;
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
  /** Hard total turn cap — override for testing (default: unlimited; the
   *  loop stops on idle detection, not turn count — Codex-style
   *  fire-and-forget for long-running development tasks). */
  maxTotalTurns?: number;
  /** Idle detection: consecutive turns with zero successful tool calls
   *  before the loop concludes the agent is stuck (default: 15). */
  maxIdleTurns?: number;
  /** Hard total token spend cap (default: 50M — generous enough for days). */
  maxTotalTokens?: number;
}): Promise<LoopResult> {
  const { provider, registry, ctx, events } = opts;
  const modelCall = opts.chatImpl ?? chat;
  // Codex-style: no turn cap. The loop runs until the model gives a final
  // answer, goes idle (no successful tool calls for N turns), or hits a
  // very generous token valve. Soft checkpoint nudges remain as guidance.
  const softTurnLimit = adaptiveMaxTurns(provider);
  const hardTurnLimit = opts.maxTotalTurns ?? Infinity; // no cap by default
  const maxIdle = opts.maxIdleTurns ?? 15; // stuck detector
  const hardTokenLimit = opts.maxTotalTokens ?? 50_000_000;
  const budget = opts.maxContextChars ?? adaptiveContextChars(provider);
  const working: ChatMessage[] = [...opts.messages];
  let toolUses = 0;
  const usage = { promptTokens: 0, completionTokens: 0 };
  const tools = registry.toOpenAITools();

  let wrapupSignaled = false;
  let turn = 0;
  let idleTurns = 0; // consecutive turns with no successful tool calls
  let reason: 'final' | 'idle' | 'turn-valve' | 'token-valve' | 'interrupted' = 'final';

  // The loop runs until the model gives a final answer (no tool calls), goes
  // idle (stuck), or hits a safety valve. Soft checkpoints at the adaptive
  // turn limit nudge the model but don't stop it — days-long tasks run
  // uninterrupted (Codex fire-and-forget philosophy).
  while (true) {
    turn++;
    if (turn > hardTurnLimit) { reason = 'turn-valve'; break; }
    if (usage.promptTokens + usage.completionTokens > hardTokenLimit) { reason = 'token-valve'; break; }
    if (opts.signal?.aborted) { reason = 'interrupted'; break; }

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
    // the model can keep working if it's mid-task (no cap, fire-and-forget).
    if (turn === softTurnLimit || (turn > softTurnLimit && turn % softTurnLimit === 0)) {
      working.push({
        role: 'system',
        content: `[turn checkpoint] You have been working for ${turn} turns. If the task is substantially complete, give your final answer. If not, continue — there is no turn limit; work until done.`,
      });
    }

    const chatRes = await modelCall(provider, compacted, tools, {
      onDelta: events?.onDelta,
    });
    usage.promptTokens += chatRes.usage?.prompt_tokens ?? 0;
    usage.completionTokens += chatRes.usage?.completion_tokens ?? 0;
    // Usage fallback: many OpenAI-compatible gateways never report usage
    // (even with stream_options.include_usage), which used to leave the token
    // valve counting zero - a runaway loop had NO stop. Estimate from the
    // wire text instead (chars/4 heuristic): coarse, but the valve only needs
    // an order of magnitude to trip at 50M.
    if (!chatRes.usage || (!chatRes.usage.prompt_tokens && !chatRes.usage.completion_tokens)) {
      const promptChars = compacted.reduce((n, m) => n + (m.content?.length ?? 0), 0);
      const replyChars = (chatRes.message.content?.length ?? 0)
        + (chatRes.message.tool_calls ?? []).reduce((n, c) => n + c.function.arguments.length, 0);
      usage.promptTokens += Math.ceil(promptChars / 4);
      usage.completionTokens += Math.ceil(replyChars / 4);
    }
    const { message } = chatRes;
    events?.onAssistant?.(message);

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      const text = message.content ?? '';
      events?.onFinal?.(text, turn);
      return { text, turns: turn, toolUses, messages: working, usage, reason: 'final' };
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
      } else if (tool.needsApproval?.(args, ctx)) {
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

    // Idle detection: count consecutive turns where NO tool succeeded. A
    // productive agent always has at least one successful call; N consecutive
    // all-fail/all-skip turns = the agent is stuck in a loop (this replaces
    // the old hard turn cap — Codex-style "run until done, not until N").
    const anySuccess = planned.some((p) => !p.isError && !p.skip);
    if (anySuccess) {
      idleTurns = 0;
    } else {
      idleTurns++;
      if (idleTurns >= maxIdle) {
        reason = 'idle';
        break;
      }
    }
    // Loop continues: the model was actively calling tools, so we keep going
    // indefinitely (no turn cap). Only idle detection or the token valve stops us.
  }

  // Safety valve or idle detection fired
  const executedTurns = reason === 'idle' ? turn : turn - 1;
  const text = reason === 'interrupted'
    ? `Task interrupted by user at turn ${turn}. Partial results preserved — the transcript is resumable.`
    : reason === 'idle'
    ? `Agent appears stuck: ${maxIdle} consecutive turns with no successful tool calls. The session is preserved — review the transcript, adjust the approach, and send a new message to continue.`
    : reason === 'turn-valve'
      ? `Turn limit reached (${executedTurns} turns). The session is preserved — send another message to continue.`
      : `Token budget limit reached (~${usage.promptTokens + usage.completionTokens} tokens). The session is preserved — send another message to continue.`;
  events?.onFinal?.(text, executedTurns);
  return { text, turns: executedTurns, toolUses, messages: working, usage, reason };
}
