/**
 * upgrade-foundation tests: saveProvider/deleteProvider/patchConfig,
 * the session goal store, and the poll-shaped mid-run injection channel.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveProvider, deleteProvider, patchConfig } from '../config.ts';
import { getGoal, setGoal, clearGoal } from '../goal.ts';
import { runLoop, type LoopEvents } from '../loop.ts';
import type { ChatMessage } from '../types.ts';

/** Isolated HMH_HOME for config tests; restored and removed afterwards. */
async function withHome<T>(prefix: string, fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const prev = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.HMH_HOME;
    else process.env.HMH_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

async function readConfig(home: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
}

test('saveProvider: insert, edit with key preservation/clearing, validation', async () => {
  await withHome('hmh-save-', async (home) => {
    // insert with key + optional fields
    await saveProvider('pro', { baseUrl: 'https://x.example/v1', model: 'm1', apiKey: 'sk-one', timeoutMs: 30000, contextWindow: 131072, supportsVision: true, authHeader: 'X-Api-Key' });
    let raw = await readConfig(home);
    assert.equal(raw.providers.pro.baseUrl, 'https://x.example/v1');
    assert.equal(raw.providers.pro.model, 'm1');
    assert.equal(raw.providers.pro.apiKey, 'sk-one');
    assert.equal(raw.providers.pro.timeoutMs, 30000);
    assert.equal(raw.providers.pro.contextWindow, 131072);
    assert.equal(raw.providers.pro.supportsVision, true);
    assert.equal(raw.providers.pro.authHeader, 'X-Api-Key');

    // edit: apiKey OMITTED (form left blank) -> existing key survives; model changes
    await saveProvider('pro', { baseUrl: 'https://x.example/v1', model: 'm2' });
    raw = await readConfig(home);
    assert.equal(raw.providers.pro.model, 'm2');
    assert.equal(raw.providers.pro.apiKey, 'sk-one', 'omitted apiKey keeps the existing key');
    // optional fields not resent are not written back (write-only-when-provided)
    assert.equal(raw.providers.pro.timeoutMs, undefined);
    assert.equal(raw.providers.pro.contextWindow, undefined);
    assert.equal(raw.providers.pro.supportsVision, undefined);
    assert.equal(raw.providers.pro.authHeader, undefined);

    // edit: apiKey '' (explicit clear) -> key deleted
    await saveProvider('pro', { baseUrl: 'https://x.example/v2', model: 'm3', apiKey: '' });
    raw = await readConfig(home);
    assert.equal(raw.providers.pro.apiKey, undefined, 'empty-string apiKey deletes the key');
    assert.equal(raw.providers.pro.model, 'm3');
    assert.equal(raw.providers.pro.baseUrl, 'https://x.example/v2');

    // validation: bad name / baseUrl / model all throw
    await assert.rejects(() => saveProvider('', { baseUrl: 'https://x/v1', model: 'm' }), /invalid provider name/);
    await assert.rejects(() => saveProvider('bad name!', { baseUrl: 'https://x/v1', model: 'm' }), /invalid provider name/);
    await assert.rejects(() => saveProvider('ok', { baseUrl: 'ftp://x/v1', model: 'm' }), /http/);
    await assert.rejects(() => saveProvider('ok', { baseUrl: 'https://x/v1', model: '' }), /model/);
    // a failed save must not touch the stored config
    raw = await readConfig(home);
    assert.equal(raw.providers.ok, undefined);
  });
});

test('deleteProvider: clears routing keys (chat/vision/evolve/bench) that point at the deleted provider', async () => {
  await withHome('hmh-del2-', async (home) => {
    await saveProvider('a', { baseUrl: 'https://a/v1', model: 'am' });
    await saveProvider('b', { baseUrl: 'https://b/v1', model: 'bm' });
    await patchConfig({ routing: { chat: 'a', vision: 'a', evolve: 'b', bench: 'a' } });
    const cfg = await deleteProvider('a');
    assert.equal(cfg.providers?.a, undefined);
    assert.equal(cfg.routing?.chat, undefined, 'chat route cleared');
    assert.equal(cfg.routing?.vision, undefined, 'vision route cleared');
    assert.equal(cfg.routing?.bench, undefined, 'bench route cleared');
    assert.equal(cfg.routing?.evolve, 'b', 'routes to other providers untouched');
    assert.equal(cfg.providers?.b?.model, 'bm');
    const raw = await readConfig(home);
    assert.equal(raw.routing.evolve, 'b');
    assert.equal(raw.routing.chat, undefined);
  });
});

test('patchConfig: top-level writes + evolution shallow merge keeps sibling keys', async () => {
  await withHome('hmh-patch-', async (home) => {
    await writeFile(join(home, 'config.json'), JSON.stringify({
      provider: { baseUrl: 'https://main/v1', apiKey: 'k', model: 'm' },
      maxTurns: 10,
      locale: 'zh',
      evolution: { autoPatch: false, holdoutRatio: 0.2 },
    }), 'utf8');
    const cfg = await patchConfig({ locale: 'en', approval: 'auto', theme: 'light', evolution: { autoPatch: true } });
    assert.equal(cfg.locale, 'en');
    assert.equal(cfg.approval, 'auto');
    assert.equal(cfg.theme, 'light');
    assert.equal(cfg.evolution?.autoPatch, true, 'evolution.autoPatch merged in');
    assert.equal((cfg.evolution as unknown as { holdoutRatio?: number }).holdoutRatio, 0.2, 'sibling evolution key survives the shallow merge');
    const raw = await readConfig(home);
    assert.equal(raw.theme, 'light', 'theme written at top level');
    assert.equal(raw.maxTurns, 10, 'other top-level keys untouched');
    assert.equal(raw.evolution.autoPatch, true);
    assert.equal(raw.evolution.holdoutRatio, 0.2);
    // patchConfig on a fresh (missing) config works too
    await rm(join(home, 'config.json'));
    const fresh = await patchConfig({ theme: 'dark' });
    assert.equal(fresh.theme, 'dark');
  });
});

test('goal store: set/get/clear roundtrip; corrupt file returns null and rebuilds', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-goal-'));
  try {
    // missing file -> null
    assert.equal(await getGoal(home, 's1'), null);
    // set + get roundtrip
    await setGoal(home, 's1', 'ship the upgrade');
    assert.equal(await getGoal(home, 's1'), 'ship the upgrade');
    // other sessions unaffected
    assert.equal(await getGoal(home, 's2'), null);
    await setGoal(home, 's2', 'other goal');
    // overwrite
    await setGoal(home, 's1', 'ship the upgrade v2');
    assert.equal(await getGoal(home, 's1'), 'ship the upgrade v2');
    assert.equal(await getGoal(home, 's2'), 'other goal');
    // clearGoal removes exactly one
    await clearGoal(home, 's1');
    assert.equal(await getGoal(home, 's1'), null);
    assert.equal(await getGoal(home, 's2'), 'other goal');
    // setGoal('') is equivalent to clearing
    await setGoal(home, 's2', '');
    assert.equal(await getGoal(home, 's2'), null);
    // stored shape: { goal, time }
    await setGoal(home, 's3', 'shape check');
    const stored = JSON.parse(await readFile(join(home, 'goals.json'), 'utf8'));
    assert.equal(typeof stored.s3.goal, 'string');
    assert.equal(typeof stored.s3.time, 'string');
    // corrupt file: getGoal -> null (no throw); setGoal rebuilds the store
    await writeFile(join(home, 'goals.json'), '{not json', 'utf8');
    assert.equal(await getGoal(home, 's3'), null);
    await setGoal(home, 's3', 'after corruption');
    assert.equal(await getGoal(home, 's3'), 'after corruption');
    const rebuilt = JSON.parse(await readFile(join(home, 'goals.json'), 'utf8'));
    assert.deepEqual(Object.keys(rebuilt), ['s3'], 'corrupt store rebuilt from the empty object');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('injections.poll: drained at every turn boundary; text lands after the tool result and reaches the next model call', async () => {
  // codex Enter-inject semantics: the injection ARRIVES while round 1 is in
  // flight (the fake tool pushes it into the queue mid-execution), so the
  // drain at round 2's boundary appends it AFTER the tool result, and the
  // in-flight round-1 request never saw it. poll returns the entry exactly
  // once, then [] on every later call.
  const pending: Array<{ text: string }> = [];
  const pollReturns: string[][] = [];
  const registry = {
    get: () => ({
      execute: async () => {
        pending.push({ text: '补充指令' }); // arrives while the round runs
        return { output: 'ok' };
      },
    }),
    toOpenAITools: () => [],
  };
  const seen: Array<Array<{ role: string; content: string | null }>> = [];
  const fakeChat = async (_cfg: unknown, msgs: Array<{ role: string; content: string | null }>) => {
    seen.push(msgs.map((m) => ({ role: m.role, content: m.content })));
    if (seen.length === 1) {
      return {
        message: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'poke', arguments: '{}' } }],
        },
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
    }
    return { message: { role: 'assistant' as const, content: 'final answer' }, usage: { prompt_tokens: 1, completion_tokens: 1 } };
  };
  const injected: string[] = [];
  const events: LoopEvents = { onInjected: (t) => injected.push(t) };
  const r = await runLoop({
    provider: { baseUrl: 'x', apiKey: '', model: 'm' },
    registry: registry as never,
    messages: [{ role: 'user', content: 'go' }] as ChatMessage[],
    ctx: { cwd: '.', home: '.' },
    chatImpl: fakeChat as never,
    injections: {
      poll: () => {
        const drained = pending.splice(0);
        pollReturns.push(drained.map((d) => d.text));
        return drained;
      },
    },
    events,
  });
  assert.equal(r.reason, 'final');
  assert.equal(r.text, 'final answer');
  assert.deepEqual(injected, ['补充指令'], 'onInjected fired once with the injected text');
  assert.deepEqual(pollReturns, [[], ['补充指令']], 'poll returned the entry exactly once, empty before and after');
  // transcript position: the injected user message sits AFTER the tool result
  const idxInj = r.messages.findIndex((m) => m.role === 'user' && m.content === '补充指令');
  const idxTool = r.messages.findIndex((m) => m.role === 'tool');
  assert.ok(idxInj !== -1, 'injected user message is in the final transcript');
  assert.ok(idxTool !== -1, 'tool result is in the final transcript');
  assert.ok(idxInj > idxTool, 'injection lands after the tool result');
  // round-1 request never saw it; round-2 request did (affects the NEXT round)
  assert.ok(!seen[0].some((m) => m.content === '补充指令'), 'in-flight round-1 request was not affected');
  assert.ok(seen[1].some((m) => m.role === 'user' && m.content === '补充指令'), 'next model call saw the injection');
});
