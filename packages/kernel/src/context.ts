/**
 * @hmharness/kernel - context
 * Char-budget context compaction. Long agent runs are dominated by stale
 * tool output; when the transcript exceeds its budget we replace the oldest
 * tool results (never the system prompt, never the task itself, never the
 * recent tail) with a tombstone. Deterministic baseline, no model call.
 *
 * Rolling digest (model-aware context engineering, part 3): with a
 * `summarize` hook, evicted content is first distilled into a persistent
 * "[rolling digest]" system note that survives future compactions and
 * merges with prior digests - the conversation's past shrinks semantically
 * instead of being dropped. Without the hook, behaviour is byte-identical
 * to the legacy prune.
 */
import type { ChatMessage } from './types.ts';

export const DEFAULT_CONTEXT_CHARS = 160_000;

export function transcriptChars(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + (m.content?.length ?? 0) + (m.tool_calls?.length ?? 0) * 80, 0);
}

/** Messages too old to prune - keep the opening (system+task) and the tail. */
function protectedRange(messages: ChatMessage[]): Set<number> {
  const keep = new Set<number>();
  // system + first user message always survive
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'system') keep.add(i);
    if (messages[i].role === 'user') {
      keep.add(i);
      break;
    }
  }
  for (let i = Math.max(0, messages.length - 8); i < messages.length; i++) keep.add(i);
  return keep;
}

export const DIGEST_MARK = '[rolling digest of earlier context]';

function findDigest(messages: ChatMessage[]): number {
  return messages.findIndex((m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith(DIGEST_MARK));
}

export function compactMessages(messages: ChatMessage[], budget = DEFAULT_CONTEXT_CHARS): ChatMessage[] {
  if (transcriptChars(messages) <= budget) return messages;
  const keep = protectedRange(messages);
  const out = messages.map((m) => ({ ...m }));
  for (let i = 0; i < out.length && transcriptChars(out) > budget; i++) {
    if (keep.has(i) || out[i].role !== 'tool') continue;
    out[i] = { ...out[i], content: '[context pruned: earlier tool output removed to fit budget]' };
  }
  return out;
}

export interface CompactResult {
  messages: ChatMessage[];
  /** Chars of tool output actually evicted this pass (0 = no compaction). */
  evictedChars: number;
}

/** Deterministic prune + tombstone; reports what was evicted so callers can
 *  feed it to a summarizer. */
export function compactWithEvictions(messages: ChatMessage[], budget = DEFAULT_CONTEXT_CHARS): CompactResult {
  if (transcriptChars(messages) <= budget) return { messages, evictedChars: 0 };
  const keep = protectedRange(messages);
  const out = messages.map((m) => ({ ...m }));
  let evicted = 0;
  for (let i = 0; i < out.length && transcriptChars(out) > budget; i++) {
    if (keep.has(i) || out[i].role !== 'tool') continue;
    evicted += out[i].content?.length ?? 0;
    out[i] = { ...out[i], content: '[context pruned: earlier tool output removed to fit budget]' };
  }
  return { messages: out, evictedChars: evicted };
}

/**
 * Compact with a rolling digest. The digest is ONE system note placed right
 * after the first user message (inside the protected head), so it survives
 * every future compaction. Each pass merges: summarize(previous digest body
 * + newly evicted tool outputs). Summarizer failures degrade silently to
 * the deterministic prune (the digest just stops growing).
 */
export async function compactWithDigest(
  messages: ChatMessage[],
  budget: number,
  summarize: (input: { previousDigest: string | null; evicted: string[] }) => Promise<string>,
): Promise<ChatMessage[]> {
  const { messages: pruned, evictedChars } = compactWithEvictions(messages, budget);
  if (evictedChars === 0) return pruned;
  const digestIdx = findDigest(pruned);
  const previousDigest = digestIdx >= 0 ? (pruned[digestIdx].content ?? '').slice(DIGEST_MARK.length).trim() : null;
  const evicted = [] as string[];
  // what was evicted = tombstoned positions vs the input (compare by index)
  for (let i = 0; i < pruned.length; i++) {
    if (pruned[i].role === 'tool' && pruned[i].content === '[context pruned: earlier tool output removed to fit budget]'
      && messages[i]?.role === 'tool' && messages[i].content !== pruned[i].content) {
      evicted.push(String(messages[i].content).slice(0, 4000));
    }
  }
  if (evicted.length === 0 && previousDigest) return pruned; // nothing new to distill
  let body: string;
  try {
    body = (await summarize({ previousDigest, evicted })).trim().slice(0, 12_000);
  } catch {
    return pruned; // summarizer down -> keep deterministic result
  }
  if (!body) return pruned;
  const note: ChatMessage = { role: 'system', content: `${DIGEST_MARK}\n${body}` };
  if (digestIdx >= 0) {
    const out = pruned.map((m, i) => (i === digestIdx ? note : m));
    return out;
  }
  // insert after the first user message (protected head)
  const firstUser = pruned.findIndex((m) => m.role === 'user');
  const at = firstUser >= 0 ? firstUser + 1 : pruned.length;
  return [...pruned.slice(0, at), note, ...pruned.slice(at)];
}
