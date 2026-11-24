/**
 * evolution - case-runner: the ONE place that turns a bench case + skills
 * prompt into model messages.
 *
 * 2026-11-25 root cause #2 (found by the plan audit, confirmed here):
 * `runEvolution` calls `runCase(case, skillsPrompt)` — the baseline gets the
 * active-skills block, the candidate gets active + draft. Three call sites
 * existed; the CLI one injected the prompt (fixed on "day-50"), but the agent
 * background loop and the TUI dropped the second parameter, so in production
 * the baseline and the candidate received IDENTICAL messages and the gate
 * compared A against A. The published log shows it: 125 of 127 promotions had
 * baseline pass rate == candidate pass rate.
 *
 * The factory below makes the injection impossible to forget: the skills
 * prompt is a required argument and always lands in the system message.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caseRunnerMessages, buildCaseRunner } from '../case-runner.ts';

test('caseRunnerMessages puts the skills prompt in the system message', () => {
  const m = caseRunnerMessages('say hi', '## Skills\n- be terse');
  assert.equal(m[0].role, 'system');
  assert.equal(m[0].content, '## Skills\n- be terse');
  assert.equal(m[1].role, 'user');
  assert.equal(m[1].content, 'say hi');
});

test('caseRunnerMessages with no skills prompt sends the user message alone', () => {
  const m = caseRunnerMessages('say hi', '');
  assert.equal(m.length, 1);
  assert.equal(m[0].role, 'user');
});

test('caseRunnerMessages distinguishes baseline from candidate injections', () => {
  const baseline = caseRunnerMessages('q', '## Active skills\nA');
  const candidate = caseRunnerMessages('q', '## Active skills\nA\n## Draft skill under evaluation: X\n...');
  assert.notEqual(baseline[0].content, candidate[0].content, 'the gate must be able to tell the two arms apart');
});

test('buildCaseRunner forwards the skills prompt to the chat call (regression: A-vs-A gate)', async () => {
  const seen: Array<Array<{ role: string; content: string }>> = [];
  const run = buildCaseRunner({
    chat: async (msgs) => { seen.push(msgs as Array<{ role: string; content: string }>); return { message: { content: 'ok' } } as never; },
  });
  await run({ prompt: 'p', tools: false } as never, 'SKILLS-BLOCK');
  await run({ prompt: 'p', tools: false } as never, 'SKILLS-BLOCK + DRAFT');
  assert.equal(seen.length, 2);
  assert.equal(seen[0][0].role, 'system');
  assert.match(seen[0][0].content, /SKILLS-BLOCK/);
  assert.match(seen[1][0].content, /DRAFT/, 'candidate injection must reach the model');
});

test('buildCaseRunner without skills prompt sends user-only (control arm unchanged)', async () => {
  const seen: Array<Array<{ role: string; content: string }>> = [];
  const run = buildCaseRunner({ chat: async (msgs) => { seen.push(msgs as Array<{ role: string; content: string }>); return { message: { content: '' } } as never; } });
  await run({ prompt: 'p', tools: false } as never, '');
  assert.equal(seen[0].length, 1);
  assert.equal(seen[0][0].role, 'user');
});

test('buildCaseRunner accepts the kernel contract (content: string | null)', async () => {
  // the real `chat` returns `content: string | null`; a null must become the
  // empty string the judge expects, never a crash or the text "null"
  const run = buildCaseRunner({ chat: async () => ({ message: { content: null } }) });
  assert.equal(await run({ prompt: 'p', tools: false } as never, 'S'), '');
});
