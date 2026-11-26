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
  /** `notRun` is set when the tool NEVER executed: 'gate' (refused by the
   *  action gate) or 'declined' (the user did not approve it). The output is
   *  still the model's tool result, but a listener that learns from outcomes
   *  must not read it as the tool failing. */
  onToolResult?(name: string, output: string, isError: boolean, notRun?: 'gate' | 'declined'): void;
  /** Called when a tool requested approval. granted=false means denied. */
  onApproval?(name: string, args: Record<string, unknown>, granted: boolean): void;
  /** Called when the pre-execution action gate was consulted (v0.24 P2A):
   *  allowed=false means the call was refused before execution. */
  onGate?(name: string, args: Record<string, unknown>, allowed: boolean, reason?: string): void;
  /** Fired when an injected user message entered the working transcript
   *  (web Ctrl+Enter / TUI Enter-while-running). The message is appended
   *  after the previous tool batch, before the next model call. */
  onInjected?(message: string): void;
  onFinal?(text: string, turns: number): void;
}

export interface LoopApproval {
  ask(toolName: string, args: Record<string, unknown>): Promise<boolean>;
}

/** Pre-execution action gate (v0.24 P2A live intervention point). The loop
 *  consults the gate BEFORE a tool call executes; a refusal becomes the tool
 *  result (the model sees the reason and can re-plan) and the tool never
 *  runs. This is the hook a learned world model uses to act on its
 *  predictions — calibration only becomes task value if it can change
 *  behavior at execution time. */
export interface LoopToolGate {
  check(name: string, args: Record<string, unknown>): Promise<
    | { allowed: true }
    | { allowed: false; reason: string }
  >;
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
    try {
      // Tool arguments must be a JSON OBJECT: "str" / null / [1,2] / 42 all
      // parse fine but leave tools reading undefined fields (v0.23.34
      // hardening - "空/截断/非对象 arguments"). Rewritten to '{}' like the
      // rest: valid on the wire, harmless to execute.
      const parsed: unknown = JSON.parse(c.function.arguments);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ...c, function: { ...c.function, arguments: '{}' } };
      }
      return c;
    } catch { return { ...c, function: { ...c.function, arguments: '{}' } }; }
  });
}

/** Appended to a final answer the output cap severed (finish_reason 'length'):
 *  the one place the user learns the reply is not whole. */
export const TRUNCATED_TAIL = '\n\n[Reply truncated: the model hit its output length limit. Send "continue" to have it pick up where it stopped.]';

/** The loop's own control notes steer ONE run. They are not conversation, and
 *  they must not ride into the next one: a stale "context is running low - wrap
 *  up" read by a later task in the same thread makes it wind down before it
 *  began. What a caller gets back is the thread without them. */
const TRANSIENT_NOTE = /^\[(?:context budget|turn checkpoint|intent only|empty reply)\]/;
function conversationOf(working: ChatMessage[]): ChatMessage[] {
  return working.filter((m) => !(m.role === 'system' && TRANSIENT_NOTE.test(String(m.content ?? ''))));
}

/** Weak-model guards (2026-11-26). The loop ends the moment the model replies
 *  without a tool call - and two replies are not answers. A weak model gives
 *  both: it only ANNOUNCES what it is about to do ("我来重命名…") and waits
 *  for a turn that never comes, or it returns nothing at all once the work is
 *  done. In an A/B on a local 9B model 2 of 3 runs ended that way; across 78
 *  real turns of glm-5.3 neither shape occurred once. Each is met with
 *  corrective notes, under conditions narrow enough that a real answer is
 *  never mistaken for either. */
// One short line that opens with a first-person statement of intent, optionally
// behind an acknowledgement ("好的，我来…", "Sure, let me…"). Anything that
// could be content disqualifies it: a second line, a colon (both widths), a
// question, a code block - and a negation, because "I will not …" is an answer.
const INTENT_ONLY = /^(?:(?:好的|没问题|明白|收到|行|OK|Sure|Alright|Certainly|Of course)[,，!！。\s]*)?(?:我(?:来|将|会|马上|这就|即将|现在)|让我|现在(?:开始|我来|就)|接下来(?:我|将|会|就)|I'?ll|I will|I am going to|I'?m going to|Let me)/i;
const NEGATION = /\b(?:not|won't|can't|cannot|never)\b|不会|不能|无法|不便|拒绝/i;
export function isIntentOnly(text: string): boolean {
  return text.length <= 120 && !/[\n:：?？]|```/.test(text) && !NEGATION.test(text) && INTENT_ONLY.test(text);
}
export const INTENT_ONLY_NOTE = '[intent only] That reply only stated what you are about to do, and no tool was called, so nothing was done. Either do it now with tool calls, or - if you are waiting for the user - say in one sentence what you are waiting for and stop.';
export const EMPTY_REPLY_NOTE = '[empty reply] The last reply was empty. If the task is done, answer with what was done. If it is not, continue with the next tool call.';
/** Shown in place of a reply that stayed empty: silence is not an answer. */
export const NO_ANSWER_NOTE = '[No answer: the model returned an empty reply. Send "continue" or rephrase.]';
const EMPTY_REPLY_RETRIES = 2;
/** Plan mode asks the model to state a plan and stop: an announcement is the
 *  right answer there. The directive rides in the messages of the task. */
const inPlanMode = (messages: ChatMessage[]): boolean =>
  messages.some((m) => m.role === 'system' && String(m.content ?? '').startsWith('[plan mode]'));

export async function runLoop(opts: {
  provider: ProviderConfig;
  registry: RegistryLike;
  messages: ChatMessage[];
  ctx: ToolContext;
  maxTurns?: number;
  /** AbortSignal: when fired, the loop stops and returns with reason
   *  "interrupted" - at the next turn boundary, or right away if the model
   *  call is in flight (the call is cut and the stop is honoured at once).
   *  Use for user-initiated cancellation (Esc key, /queue skip, web API
   *  interrupt). */
  signal?: AbortSignal;
  /** Explicit transcript budget override (chars). Default: scales with the
   *  model's context window (window.ts registry / provider.contextWindow). */
  maxContextChars?: number;
  approval?: LoopApproval;
  /** Pre-execution action gate (v0.24 P2A): consulted BEFORE approval — an
   *  automated gate should not wake the human dialog for a call it already
   *  blocks. A refusal never executes the tool; the reason becomes its tool
   *  result so the model can choose another path. */
  toolGate?: LoopToolGate;
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
  let emptyReplies = 0; // weak-model guard 1: empty replies re-asked so far
  let nudged = false; // weak-model guard 2: one "announce and stop" correction per run
  const planMode = inPlanMode(opts.messages);

  // Re-verification loop breaker (2026-10-07 export: 108 tool calls in 5
  // user turns, 20+ turns re-deriving the SAME fact because the earlier tool
  // result got tombstoned by compaction and the model doesn't trust its own
  // text conclusions). Ring of recent (tool+args) → result head; an EXACT
  // repeat returns the cached result with a note, saving a network call and
  // telling the model it already knows this.
  //
  // 2026-11-25: the ring used to cache EVERY successful call and nothing
  // invalidated it - so "edit → re-run the same command" (the core agent
  // loop) got the PRE-edit result back. Only readOnly tools are cached now,
  // and only while `world` is unchanged: every state-changing execution and
  // every runtime injection bumps it.
  const recentCalls = new Map<string, { head: string; isError: boolean; turn: number; world: number }>();
  let world = 0;
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
      world++; // the user acted out of band: whatever was read before may be gone
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

    let chatRes: Awaited<ReturnType<typeof modelCall>>;
    try {
      chatRes = await modelCall(provider, compacted, tools, {
        onDelta: events?.onDelta,
        // the abort must pierce the in-flight call, not just turn boundaries -
        // a hung provider stream otherwise holds the session busy forever
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (err) {
      // The abort pierces this call by design, so a stop that lands while the model
      // is streaming arrives HERE as a rejected request. Until 0.23.55 it escaped the
      // loop as a provider failure: the web UI showed "provider: request aborted …
      // task child exit 1" for a stop the user had pressed on purpose. It is the same
      // stop as one noticed at a turn boundary - keep what was built and say so.
      if (opts.signal?.aborted) { reason = 'interrupted'; break; }
      throw err;
    }
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
      // The answer joins the conversation before anything else happens: a
      // follow-up has to see what was answered here. Until 0.23.56 the final
      // reply was never added to the working transcript, so every continuation
      // of a thread lost the one message that mattered most.
      working.push({ role: 'assistant', content: message.content ?? null });
      let text = message.content ?? '';
      // A runtime-steering injection may have arrived while this turn was in
      // flight; honor it by continuing instead of ending (codex Enter while
      // the last answer streams). Only end when the queue is empty.
      const pending = opts.injectQueue?.();
      if (pending) {
        working.push({ role: 'user', content: pending });
        events?.onInjected?.(pending);
        world++;
        continue;
      }
      // The output cap cut the answer mid-sentence (finish_reason 'length').
      // Nothing else on the wire says so, and until 0.23.55 the severed text
      // reached every surface dressed as a complete reply. The marker travels
      // as a text delta: the web UI, the TUI and the one-shot task render the
      // STREAM and never the returned text, so a tail appended to the return
      // value alone was seen nowhere. This also keeps the return equal to what
      // was streamed. The stored transcript keeps the raw message.
      if (chatRes.finishReason === 'length') {
        events?.onDelta?.('text', TRUNCATED_TAIL);
        text += TRUNCATED_TAIL;
        events?.onFinal?.(text, turn);
        return { text, turns: turn, toolUses, messages: conversationOf(working), usage, reason: 'final' };
      }
      // Weak-model guard 1 - the empty reply (2026-11-26). A 9B model finished
      // its edits and then returned no text and no tool call, and the loop
      // took that for a final answer: the user was shown nothing at all. The
      // empty step goes back out of the transcript (a content-less assistant
      // message is not a valid history item) and the model is asked again,
      // twice at most - a model with nothing to say gets to say so.
      if (!text.trim()) {
        if (emptyReplies < EMPTY_REPLY_RETRIES) {
          emptyReplies++;
          working.pop();
          working.push({ role: 'system', content: EMPTY_REPLY_NOTE });
          continue;
        }
        events?.onDelta?.('text', NO_ANSWER_NOTE);
        text = NO_ANSWER_NOTE;
      } else if (toolUses === 0 && !nudged && !planMode && isIntentOnly(text.trim())) {
        // Weak-model guard 2 - "announce and stop" (2026-11-26). Asked to
        // rename a function, the same model answered "我来重命名…" and
        // stopped: it had stated the intent and waited for a turn. Nothing
        // has run yet in this task and the reply is a bare statement of
        // intent, so it is told once to act (or to say what it is waiting
        // for). After any tool has run the same sentence may be a legitimate
        // last word, and a plan-mode reply is a plan - neither is touched.
        nudged = true;
        working.push({ role: 'system', content: INTENT_ONLY_NOTE });
        continue;
      }
      events?.onFinal?.(text, turn);
      return { text, turns: turn, toolUses, messages: conversationOf(working), usage, reason: 'final' };
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
      notRun?: 'gate' | 'declined'; // set when it did not run for a reason that is not the tool's
    }
    const planned: Planned[] = [];
    for (const call of calls) {
      const name = call.function.name;
      const rawArgs = call.function.arguments;
      let args: Record<string, unknown> = {};
      let badArgs = false;
      if (rawArgs) {
        try {
          const parsed: unknown = JSON.parse(rawArgs);
          // valid JSON but NOT an object ("str"/null/[1,2]/42): tools would
          // read undefined fields - treat like unparseable (skip + clear msg)
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) badArgs = true;
          else args = parsed as Record<string, unknown>;
        } catch { badArgs = true; }
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
        p.output = chatRes.finishReason === 'length'
          ? `the ${name} call was cut off by the model's output length limit before its JSON arguments were complete. Repeat it with a much smaller payload (split a long file into several smaller writes).`
          : rawArgs
            ? `unparseable tool arguments for ${name} (arguments must be valid JSON — repeat the call with complete JSON): ${rawArgs.slice(0, 200)}`
            : `empty tool arguments for ${name} (arguments must be valid JSON — repeat the call with complete JSON)`;
        p.isError = true;
        p.skip = true;
      } else {
        // v0.24 P2A intervention point: the gate runs BEFORE approval (an
        // automated refusal should not queue a human dialog) and BEFORE
        // execution. A refusal never executes the tool; the reason becomes
        // its tool result so the model sees WHY and can re-plan. An ALLOW
        // falls through to the normal approval path — the gate never
        // substitutes for the human dialog on risky tools.
        let refused: string | null = null;
        if (opts.toolGate) {
          const verdict = await opts.toolGate.check(name, args);
          events?.onGate?.(name, args, verdict.allowed, verdict.allowed ? undefined : verdict.reason);
          if (!verdict.allowed) refused = verdict.reason;
        }
        if (refused !== null) {
          p.output = `[action gate] ${refused}`;
          p.isError = true;
          p.skip = true;
          p.notRun = 'gate';
        } else if (tool.needsApproval?.(args, ctx)) {
          // Safe default: with no gate wired in, risky tools are denied.
          const granted = opts.approval ? await opts.approval.ask(name, args) : false;
          events?.onApproval?.(name, args, granted);
          if (!granted) {
            p.output = 'User declined this action. Ask how to proceed or find a non-destructive alternative.';
            p.isError = true;
            p.skip = true;
            p.notRun = 'declined';
          }
        }
      }
      planned.push(p);
    }
    // A batch that contains any state-changing call leaves every cached read
    // behind: bump the world BEFORE the cache lookups of this batch.
    for (const p of planned) if (!p.skip && !registry.get(p.name)!.readOnly) world++;
    await Promise.all(planned.map(async (p) => {
      if (p.skip) return;
      // Re-verification breaker: an EXACT repeat (same tool, same args) of a
      // recent successful readOnly call returns the cached head instead of
      // re-running - but only if nothing has changed the world since. The note
      // tells the model WHY, so it stops trying to re-verify.
      const key = callKey(p.name, p.args);
      const prev = recentCalls.get(key);
      if (registry.get(p.name)!.readOnly === true && prev && !prev.isError && prev.world === world && turn - prev.turn <= 20) {
        p.output = `[you already ran ${p.name} with these exact arguments at turn ${prev.turn}; re-running identical calls wastes time — here is what it returned]\n${prev.head}`;
        p.isError = false;
        return;
      }
      try {
        const r = await registry.get(p.name)!.execute(p.args, ctx);
        p.output = r.output;
        p.isError = r.isError === true;
        // remember successful READ-ONLY results for the dedup ring (errors go
        // through the failed-command short-circuit instead)
        if (!p.isError && registry.get(p.name)!.readOnly === true) {
          recentCalls.set(key, { head: p.output.slice(0, RESULT_HEAD_CHARS), isError: false, turn, world });
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
      events?.onToolResult?.(p.name, p.output, p.isError, p.notRun);
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
      world++; // the user acted out of band: whatever was read before may be gone
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
  return { text, turns: executedTurns, toolUses, messages: conversationOf(working), usage, reason };
}
