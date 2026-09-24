import test from 'node:test';
import assert from 'node:assert/strict';
import { runLoop, type LoopEvents } from '../loop.ts';
import { Registry } from '../registry.ts';
import type { Tool } from '../types.ts';

/** Fake provider: first turn calls one tool, then answers. The final-answer
 *  text is a function so tests can assert the injected steering was SEEN
 *  (turn 2 answers "SAW:<injected>"). */
function steeringProvider() {
  let turn = 0;
  let seenInjection: string | null = null;
  return {
    seen: () => seenInjection,
    async chat(_cfg: unknown, msgs: Array<{ role: string; content: string | null }>) {
      // find the last user message with an injection marker
      for (const m of msgs) {
        if (m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[inject]')) seenInjection = m.content;
      }
      turn++;
      if (turn === 1) {
        return { message: { role: 'assistant' as const, content: null, tool_calls: [{ id: 'c1', function: { name: 'poke', arguments: '{}' } }] }, usage: { prompt_tokens: 1, completion_tokens: 1 } };
      }
      return { message: { role: 'assistant' as const, content: 'done' }, usage: { prompt_tokens: 1, completion_tokens: 1 } };
    },
  };
}

const pokeTool: Tool = {
  name: 'poke',
  description: 'no-op',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute() { return { output: 'poked' }; },
};

test('injectQueue: a message pushed during the tool batch reaches the next model turn', async () => {
  const reg = new Registry();
  reg.register(pokeTool);
  const sp = steeringProvider();
  let injectedEvents: string[] = [];
  const queue = ['[inject] now also update the README'];
  const r = await runLoop({
    provider: sp as never,
    registry: reg,
    messages: [{ role: 'user', content: 'go' }],
    ctx: { cwd: '.', home: '.' },
    chatImpl: sp.chat as never,
    injectQueue: () => queue.length ? queue.shift()! : null,
    events: { onInjected: (m) => injectedEvents.push(m) } as LoopEvents,
  });
  assert.equal(r.text, 'done');
  assert.equal(r.turns, 2, 'injection extends the loop past the natural final turn');
  assert.equal(sp.seen(), '[inject] now also update the README', 'the model call saw the injected user message');
  assert.deepEqual(injectedEvents, ['[inject] now also update the README']);
});

test('injectQueue: an injection arriving DURING the final answer is honored (no lost steering)', async () => {
  // provider returns a final answer on turn 1 (no tools); the injection lands
  // while that answer is in flight -> loop must continue, not end
  const reg = new Registry();
  reg.register(pokeTool);
  let turns = 0;
  let sawInjected = false;
  const sp = {
    async chat(_cfg: unknown, msgs: Array<{ role: string; content: string | null }>) {
      for (const m of msgs) {
        if (m.role === 'user' && m.content === '[inject] steer') sawInjected = true;
      }
      turns++;
      return { message: { role: 'assistant' as const, content: 'answer' }, usage: { prompt_tokens: 1, completion_tokens: 1 } };
    },
  };
  const queue: string[] = ['[inject] steer'];
  const r = await runLoop({
    provider: sp as never,
    registry: reg,
    messages: [{ role: 'user', content: 'go' }],
    ctx: { cwd: '.', home: '.' },
    chatImpl: sp.chat as never,
    // the first call observes the final answer branch and the queue is STILL
    // non-empty -> loop continues; the second model call sees the injection
    injectQueue: () => queue.length ? queue.shift()! : null,
  });
  assert.equal(r.turns, 2, 'final-answer injection keeps the loop alive one more turn');
  assert.ok(sawInjected, 'the injected message was fed into the transcript');
});

test('injectQueue: no injection -> loop ends at the natural final answer', async () => {
  const reg = new Registry();
  reg.register(pokeTool);
  const sp = steeringProvider();
  const r = await runLoop({
    provider: sp as never,
    registry: reg,
    messages: [{ role: 'user', content: 'go' }],
    ctx: { cwd: '.', home: '.' },
    chatImpl: sp.chat as never,
  });
  assert.equal(r.text, 'done');
  assert.equal(r.turns, 2, 'tool turn + final turn, no injection extends it');
  assert.equal(sp.seen(), null);
});
