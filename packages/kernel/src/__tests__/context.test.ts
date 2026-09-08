import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactMessages, compactWithDigest, compactWithEvictions, transcriptChars, DEFAULT_CONTEXT_CHARS, DIGEST_MARK } from '../context.ts';
import { contextWindowFor, contextBudgetChars, adaptiveContextChars } from '../window.ts';
import { runLoop } from '../loop.ts';
import type { ChatMessage } from '../types.ts';

const mk = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content });

test('compactMessages: no-op under budget', () => {
  const msgs = [mk('system', 'sys'), mk('user', 'task')];
  const out = compactMessages(msgs, 1000);
  assert.equal(out.length, 2);
  assert.equal(out[0].content, 'sys');
});

test('compactMessages: prunes oldest tool outputs, protects opening and tail', () => {
  const msgs: ChatMessage[] = [
    mk('system', 'sys'),
    mk('user', 'task'),
    mk('assistant', 'call'),
    ...Array.from({ length: 30 }, (_, i) => mk('tool', 'x'.repeat(1000) + i)),
    mk('assistant', 'tail-answer'),
  ];
  const out = compactMessages(msgs, 8000);
  assert.equal(out[0].content, 'sys');
  assert.equal(out[1].content, 'task');
  assert.equal(out[out.length - 1].content, 'tail-answer');
  const pruned = out.filter((m) => (m.content ?? '').startsWith('[context pruned')).length;
  // tools at idx 3..25 (23 of them) pruned; the last 8 messages (7 tools + tail) stay protected
  assert.equal(pruned, 23);
  assert.ok(transcriptChars(out) < transcriptChars(msgs));
});

test('default budget is sane', () => {
  assert.ok(DEFAULT_CONTEXT_CHARS >= 50_000);
});

import { resolveProvider, type HmhConfig } from '../types.ts';

/* -------- model-aware context engineering (window registry + budgets) -------- */

test('contextWindowFor: explicit config wins, registry matches, unknown is null', () => {
  assert.deepEqual(contextWindowFor({ model: 'whatever', contextWindow: 300_000 }), { windowTokens: 300_000, source: 'config' });
  assert.equal(contextWindowFor({ model: 'glm-5.3' }).windowTokens, 131_072);
  assert.equal(contextWindowFor({ model: 'deepseek-chat' }).windowTokens, 128_000);
  assert.equal(contextWindowFor({ model: 'claude-sonnet-4-5' }).windowTokens, 200_000);
  assert.equal(contextWindowFor({ model: 'qwen3-max' }).windowTokens, 131_072);
  assert.deepEqual(contextWindowFor({ model: 'totally-unknown-model' }), { windowTokens: null, source: 'unknown' });
});

test('contextBudgetChars: 128K window keeps the legacy default; scales up, clamped both ends', () => {
  assert.equal(contextBudgetChars(null), 160_000, 'unknown model -> legacy fixed budget, behaviour unchanged');
  assert.equal(contextBudgetChars(131_072), Math.round(131_072 * 2.5 * 0.5), 'glm-class window scales');
  assert.equal(contextBudgetChars(200_000), 250_000);
  assert.equal(contextBudgetChars(1_000_000), 1_000_000, 'capped even on 1M windows');
  assert.equal(contextBudgetChars(8_000), 40_000, 'small windows never go below the floor');
});

test('adaptiveContextChars: provider -> budget in one call', () => {
  assert.equal(adaptiveContextChars({ model: 'glm-5.3' }), Math.round(131_072 * 1.25));
  assert.equal(adaptiveContextChars({ model: 'mystery' }), 160_000);
  assert.equal(adaptiveContextChars({ model: 'mystery', contextWindow: 200_000 }), 250_000);
});

/* -------- rolling digest -------- */

test('compactWithDigest: evicted content becomes a persistent digest note; second pass MERGES it', async () => {
  const msgs: ChatMessage[] = [
    mk('system', 'sys'),
    mk('user', 'task'),
    ...Array.from({ length: 30 }, (_, i) => mk('tool', 'build log ' + i + ': ' + 'x'.repeat(1000))),
    mk('assistant', 'tail-answer'),
  ];
  const seen: Array<{ previousDigest: string | null; evicted: string[] }> = [];
  const summarize = async (input: { previousDigest: string | null; evicted: string[] }) => {
    seen.push(input);
    return input.previousDigest ? 'merged digest v2' : 'digest v1';
  };
  const first = await compactWithDigest(msgs, 8000, summarize);
  // digest note exists, right after the first user message, inside the protected head
  const digestIdx = first.findIndex((m) => m.role === 'system' && (m.content ?? '').startsWith(DIGEST_MARK));
  assert.ok(digestIdx === 2, 'digest sits directly after system+user');
  assert.match(first[digestIdx].content ?? '', /digest v1/);
  assert.ok(seen[0].evicted.length > 0 && seen[0].evicted[0].includes('build log 0'), 'evicted text reached the summarizer');
  assert.equal(seen[0].previousDigest, null);

  // second compaction pass over a GROWN transcript (the realistic case: the
  // conversation keeps going after a compaction): previous digest is merged,
  // the note is replaced, not duplicated
  const grown: ChatMessage[] = [
    ...first,
    ...Array.from({ length: 15 }, (_, i) => mk('tool', 'second wave ' + i + ': ' + 'y'.repeat(1000))),
    mk('assistant', 'tail-2'),
  ];
  const second = await compactWithDigest(grown, 8000, summarize);
  const digests = second.filter((m) => (m.content ?? '').startsWith(DIGEST_MARK));
  assert.equal(digests.length, 1, 'exactly one digest note - replaced, not appended');
  assert.match(digests[0].content ?? '', /digest v2/);
  assert.equal(seen[1].previousDigest, 'digest v1', 'previous digest was passed back for merging');
});

test('compactWithDigest: summarizer failure degrades to the deterministic prune', async () => {
  const msgs: ChatMessage[] = [
    mk('system', 'sys'),
    mk('user', 'task'),
    ...Array.from({ length: 30 }, () => mk('tool', 'y'.repeat(1000))),
    mk('assistant', 'tail'),
  ];
  const out = await compactWithDigest(msgs, 8000, async () => { throw new Error('summarizer down'); });
  const baseline = compactWithEvictions(msgs, 8000).messages;
  assert.deepEqual(out, baseline, 'no digest, identical to legacy behaviour');
  assert.equal(out.filter((m) => (m.content ?? '').startsWith(DIGEST_MARK)).length, 0);
});

test('compactWithDigest: under budget = no-op, summarizer never called', async () => {
  let calls = 0;
  const out = await compactWithDigest([mk('system', 's'), mk('user', 'hi')], 10_000, async () => { calls++; return 'x'; });
  assert.equal(calls, 0);
  assert.equal(out.length, 2);
});

test('runLoop: adaptive glm budget + rolling digest reach the model call', async () => {
  const seen: ChatMessage[][] = [];
  const chatImpl = (async (_p: unknown, messages: ChatMessage[]) => {
    seen.push(messages);
    return { message: { role: 'assistant' as const, content: 'done' } };
  }) as unknown as typeof import('../provider.ts')['chat'];
  const registry = { toOpenAITools: () => [] } as never;
  const messages: ChatMessage[] = [
    mk('system', 'sys'),
    mk('user', 'big task'),
    ...Array.from({ length: 30 }, () => mk('tool', 'z'.repeat(8000))),
    mk('assistant', 'tail'),
  ]; // ~240k chars -> over the glm-class adaptive budget (163_840)
  await runLoop({
    provider: { baseUrl: 'http://x', apiKey: 'k', model: 'glm-5.3' },
    registry,
    messages,
    ctx: { cwd: '.', home: '.' },
    chatImpl,
    summarizeContext: async () => 'SUMMARY-OF-EVICTED',
  });
  assert.ok(seen.length >= 1);
  assert.ok(seen[0].some((m) => (m.content ?? '').startsWith(DIGEST_MARK)), 'model received the digest note');
  assert.ok(seen[0].some((m) => m.content === 'SUMMARY-OF-EVICTED' || (m.content ?? '').includes('SUMMARY-OF-EVICTED')));
});

test('resolveProvider: routing wins, falls back to legacy fields', () => {
  const base: HmhConfig = {
    provider: { baseUrl: 'http://legacy', apiKey: 'k', model: 'm' },
    vision: { baseUrl: 'http://legacy-v', apiKey: 'k', model: 'v' },
    maxTurns: 1,
  };
  assert.equal(resolveProvider(base, 'chat').baseUrl, 'http://legacy');
  assert.equal(resolveProvider(base, 'vision').baseUrl, 'http://legacy-v');
  const routed: HmhConfig = {
    ...base,
    providers: {
      strong: { baseUrl: 'http://strong', apiKey: 'k', model: 's' },
      eye: { baseUrl: 'http://eye', apiKey: 'k', model: 'e' },
    },
    routing: { chat: 'strong', vision: 'eye' },
  };
  assert.equal(resolveProvider(routed, 'chat').baseUrl, 'http://strong');
  assert.equal(resolveProvider(routed, 'vision').baseUrl, 'http://eye');
  assert.equal(resolveProvider(routed, 'evolve').baseUrl, 'http://strong'); // evolve/bench inherit the chat route
  assert.equal(resolveProvider(routed, 'bench').baseUrl, 'http://strong');
});
