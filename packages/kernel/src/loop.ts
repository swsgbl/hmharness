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
  /** Fired when an injected user message entered the working transcript
   *  (web Ctrl+Enter / TUI Enter-while-running). The message is appended
   *  after the previous tool batch, before the next model call. */
  onInjected?(message: string): void;
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

/** A model occasionally emits tool-call arguments that are not valid JSON —
 *  an empty string, or a long argument list truncated mid-string (weak/flash
 *  models do both under long outputs; agnes-3.0-flash hit each once on
 *  2026-10-08). Every OpenAI-compatible provider REJECTS any request whose
 *  assistant history carries such a call (HTTP 400 "Assistant tool call
 *  arguments must be valid JSON"), so one malformed call used to kill the
 *  whole task on the NEXT turn. Sanitizing rewrites only the stored
 *  arguments to '{}' — the paired error tool result already tells the model
 *  what happened, and valid calls pass through byte-for-byte. Shared by the
 *  live loop (before the assistant message enters the transcript) and
 *  loadTranscript (before a replayed rollout re-enters one). */
export function sanitizeToolCalls<T extends { function: { arguments: string } }>(calls: T[]): T[] {
  return calls.map((c) => {
    if (!c.function?.arguments) return { ...c, function: { ...c.function, arguments: '{}' } };
    try { JSON.parse(c.function.arguments); return c; }
    catch { return { ...c, function: { ...c.function, arguments: '{}' } }; }
  });
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
  /** Injected user messages (web Ctrl+Enter / TUI Enter-while-running):
   *  called after every tool-result batch; the returned string (or null)
   *  is appended to the working transcript as a user message before the
   *  next model call. Absent -> no injection support (codex-style runtime
   *  steering disabled). */
  injectQueue?: () => string | null;
  /** Polled at every turn boundary (and before the first model call): user
   *  texts injected into the RUNNING loop (codex Enter-inject semantics).
   *  poll() drains its pending queue; each entry becomes a user turn. */
  injections?: { poll(): Array<{ text: string }> };
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

  // Re-verification loop breaker (2026-10-07 export: 108 tool calls in 5
  // user turns, 20+ turns re-deriving the SAME fact because the earlier tool
  // result got tombstoned by compaction and the model doesn't trust its own
  // text conclusions). Ring of recent (tool+args) → result head; an EXACT
  // repeat returns the cached result with a note, saving a network call and
  // telling the model it already knows this.
  const recentCalls = new Map<string, { head: string; isError: boolean; turn: number }>();
  const callKey = (name: string, args: Record<string, unknown>) => {
    try { return name + ':' + JSON.stringify(args); } catch { return name + ':unserializable'; }
  };
  const RESULT_HEAD_CHARS = 500;

  // The loop runs until the model gives a final answer (no tool calls), goes
  // idle (stuck), or hits a safety valve. Soft checkpoints at the adaptive
  // turn limit nudge the model but don't stop it — days-long tasks run
  // uninterrupted (Codex fire-and-forget philosophy).
  while (true) {
    turn++;
    if (turn > hardTurnLimit) { reason = 'turn-valve'; break; }
    if (usage.promptTokens + usage.completionTokens > hardTokenLimit) { reason = 'token-valve'; break; }
    if (opts.signal?.aborted) { reason = 'interrupted'; break; }

    // Mid-run injection drain (codex Enter-inject semantics): entries queued
    // while the previous round's model request / tool batch was in flight
    // join the transcript here, so the NEXT model call sees them. An
    // injection never affects a request already issued this round.
    for (const inj of opts.injections?.poll() ?? []) {
      working.push({ role: 'user', content: inj.text });
      events?.onInjected?.(inj.text);
    }

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
      // A runtime-steering injection may have arrived while this turn was in
      // flight; honor it by continuing instead of ending (codex Enter while
      // the last answer streams). Only end when the queue is empty.
      const pending = opts.injectQueue?.();
      if (pending) {
        working.push({ role: 'user', content: pending });
        events?.onInjected?.(pending);
        continue;
      }
      events?.onFinal?.(text, turn);
      return { text, turns: turn, toolUses, messages: working, usage, reason: 'final' };
    }

    // Poison control: invalid-JSON arguments must never enter the transcript
    // raw — the provider 400s the whole next request otherwise (see
    // sanitizeToolCalls). The rollout recorder keeps the raw call via
    // onAssistant; this is only the wire-boundary copy.
    working.push({ role: 'assistant', content: message.content ?? null, tool_calls: sanitizeToolCalls(calls) });

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
      const rawArgs = call.function.arguments;
      let args: Record<string, unknown> = {};
      let badArgs = false;
      if (rawArgs) {
        try { args = JSON.parse(rawArgs) as Record<string, unknown>; }
        catch { badArgs = true; }
      } else {
        // Empty-string arguments are invalid JSON to every provider too (they
        // 400 on replay). Executing with {} used to produce a confusing shell
        // error ("The argument 'file' cannot be empty") — skip with a clear
        // message so the model repeats the call properly.
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
        p.output = rawArgs
          ? `unparseable tool arguments for ${name} (arguments must be valid JSON — repeat the call with complete JSON): ${rawArgs.slice(0, 200)}`
          : `empty tool arguments for ${name} (arguments must be valid JSON — repeat the call with complete JSON)`;
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
      // Re-verification breaker: an EXACT repeat (same tool, same args) of a
      // recent successful call returns the cached head instead of re-running.
      // The note tells the model WHY, so it stops trying to re-verify.
      const key = callKey(p.name, p.args);
      const prev = recentCalls.get(key);
      if (prev && !prev.isError && turn - prev.turn <= 20) {
        p.output = `[you already ran ${p.name} with these exact arguments at turn ${prev.turn}; re-running identical calls wastes time — here is what it returned]\n${prev.head}`;
        p.isError = false;
        return;
      }
      try {
        const r = await registry.get(p.name)!.execute(p.args, ctx);
        p.output = r.output;
        p.isError = r.isError === true;
        // remember successful results for the dedup ring (errors go through
        // the failed-command short-circuit instead)
        if (!p.isError) {
          recentCalls.set(key, { head: p.output.slice(0, RESULT_HEAD_CHARS), isError: false, turn });
          if (recentCalls.size > 50) {
            // drop the oldest entries when the ring fills
            const firstKey = recentCalls.keys().next().value;
            if (firstKey !== undefined) recentCalls.delete(firstKey);
          }
        }
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

    // Runtime steering (codex Enter-while-running): a user message injected
    // during the tool batch joins the transcript here, so the NEXT model call
    // already sees it. Multiple pushes are drained in FIFO order.
    const injected = opts.injectQueue?.();
    if (injected) {
      working.push({ role: 'user', content: injected });
      events?.onInjected?.(injected);
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
