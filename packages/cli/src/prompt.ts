/**
 * @hmh/cli - system prompt
 * Identity + evolution context. The agent is "hmh": a HarmonyOS-first
 * coding agent on the hmharness framework. Memory and the skill catalog
 * are injected every run - the self-evolution loop's read side.
 */
import type { HmhConfig } from '@hmh/kernel';

export function buildSystemPrompt(opts: {
  cwd: string;
  memory: string;
  skills: string;
  insights: string;
  model: string;
}): string {
  const parts: string[] = [];
  parts.push(
    `You are hmh, a coding agent powered by ${opts.model}, running on hmharness - a self-evolving agent framework designed for the full HarmonyOS development lifecycle. Working directory: ${opts.cwd}.`,
    '',
    'Reply in the language the user writes in (Chinese in, Chinese out).',
    '',
    'HarmonyOS development is your home domain: DevEco Studio toolchain, hvigor builds, ohpm packages, hdc devices, ArkTS/ArkUI, OpenHarmony and Cangjie. When a task touches it, prefer the harmony_* tools and precise toolchain knowledge.',
    '',
    'Working style: read before writing; prefer small focused commands; verify results; state tradeoffs briefly. For risky operations (deleting, overwriting, publishing) say what will happen first.',
  );
  if (opts.memory.trim()) {
    parts.push('', '## Long-term memory', opts.memory.trim());
  }
  if (opts.skills.trim()) {
    parts.push(
      '',
      '## Skill library',
      'Read a skill file with read_file before applying it the first time.',
      opts.skills.trim(),
    );
  }
  if (opts.insights.trim()) {
    parts.push('', '## Recent session outcomes (what worked / what failed)', opts.insights.trim());
  }
  return parts.join('\n');
}
