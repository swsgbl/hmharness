/**
 * @hmharness/evolution - case-runner
 *
 * The ONE place that turns a bench case + skills prompt into model messages.
 *
 * Root cause #2 (2026-11-25): `runEvolution` calls `runCase(case, skillsPrompt)`
 * - the baseline receives the active-skills block, the candidate receives
 * active + draft. Three call sites existed and two of them (the agent
 * background loop and the TUI) silently dropped the second parameter, so in
 * production both arms got IDENTICAL messages and the promotion gate compared
 * A against A. The published evolution log shows the fingerprint: 125 of 127
 * promotions had baseline pass rate == candidate pass rate.
 *
 * This module makes the injection impossible to forget: the skills prompt is
 * a required parameter of `caseRunnerMessages` and always lands in the
 * system message. Every `runEvolution` call site builds its runner from here
 * (the CLI's own `makeCaseRunner` was the correct reference implementation -
 * it had fixed the same defect on "day-50" - so this is that fix, shared).
 */

export type ChatMessage = { role: 'system' | 'user'; content: string };

/** Messages for a non-tool bench case. An empty skills prompt yields the
 *  user message alone, which keeps the control arm byte-identical to the
 *  pre-skills behavior. */
export function caseRunnerMessages(prompt: string, skillsPrompt: string): ChatMessage[] {
  if (skillsPrompt) {
    return [
      { role: 'system', content: skillsPrompt },
      { role: 'user', content: prompt },
    ];
  }
  return [{ role: 'user', content: prompt }];
}

export interface CaseRunnerDeps {
  /** One model turn. Receives exactly what `caseRunnerMessages` built.
   *  `content` may be null - that is the kernel's ChatResponse contract
   *  (`content: string | null`), so callers can pass `chat` straight through. */
  chat: (messages: ChatMessage[]) => Promise<{ message: { content?: string | null } }>;
}

/** A `runEvolution`-compatible `runCase` for the plain (non-tool) bench cases.
 *  Returns the function itself - the exact shape `runEvolution` expects, so a
 *  call site reads `runCase: buildCaseRunner({ chat })`.
 *  Tool cases (`c.tools`) need a live agent loop, so they are the caller's
 *  concern: route them before calling this and pass the skills prompt into
 *  the loop's system prompt yourself (the agent runner shows the pattern). */
export function buildCaseRunner(deps: CaseRunnerDeps): (c: { prompt: string; tools: boolean }, skillsPrompt: string) => Promise<string> {
  return async (c, skillsPrompt) => {
    const r = await deps.chat(caseRunnerMessages(c.prompt, skillsPrompt));
    return r.message.content ?? '';
  };
}
