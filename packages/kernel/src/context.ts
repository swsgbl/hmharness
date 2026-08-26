/**
 * @hmh/kernel - context
 * Char-budget context compaction. Long agent runs are dominated by stale
 * tool output; when the transcript exceeds its budget we replace the oldest
 * tool results (never the system prompt, never the task itself, never the
 * recent tail) with a tombstone. Deterministic, no model call, no surprise.
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
