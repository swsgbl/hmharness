/**
 * @hmharness/agent - Agent Skills Conformance (P1-06)
 *
 * The audit called for: "官方 SKILL.md 格式 + scripts/references/assets +
 * cross-runtime fixtures"
 *
 * Validates skill definitions against the Agent Skills spec so they can
 * migrate across hmharness / Codex / Claude Code / Goose / other clients.
 */

export interface SkillManifest {
  name: string;
  description: string;
  /** optional metadata */
  version?: string;
  /** entry point script (relative to skill dir) */
  entry?: string;
  /** supported file structure */
  files: {
    'SKILL.md': boolean;
    'scripts/'?: boolean;
    'references/'?: boolean;
    'assets/'?: boolean;
  };
}

export interface ConformanceResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** conformance level achieved */
  level: 'full' | 'partial' | 'none';
}

/**
 * Validate a SKILL.md content against the Agent Skills format.
 * Pure - testable.
 */
export function validateSkillMd(content: string): ConformanceResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  // must have YAML-like frontmatter
  if (!content.startsWith('---')) {
    errors.push('SKILL.md must start with YAML frontmatter (---)');
  } else {
    const end = content.indexOf('---', 3);
    if (end === -1) {
      errors.push('SKILL.md frontmatter not closed');
    } else {
      const fm = content.slice(3, end);
      if (!/name\s*:/.test(fm)) errors.push('frontmatter missing "name" field');
      if (!/description\s*:/.test(fm)) errors.push('frontmatter missing "description" field');
    }
  }
  // must have some content after frontmatter
  const body = content.replace(/^---[\s\S]*?---/, '').trim();
  if (body.length < 10) warnings.push('SKILL.md body is very short (<10 chars)');
  // check for common sections
  if (!/## (usage|how to use|instructions)/i.test(body)) warnings.push('no usage/instructions section found');
  const valid = errors.length === 0;
  const level = valid ? (warnings.length === 0 ? 'full' : 'partial') : 'none';
  return { valid, errors, warnings, level };
}

/**
 * Check a skill directory structure for conformance.
 * Pure - testable.
 */
export function validateSkillStructure(files: string[]): ConformanceResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!files.includes('SKILL.md')) errors.push('SKILL.md not found');
  if (!files.some(f => f.startsWith('scripts/'))) warnings.push('no scripts/ directory (optional but recommended)');
  if (!files.some(f => f.startsWith('references/'))) warnings.push('no references/ directory (optional)');
  const valid = errors.length === 0;
  const level = valid ? (warnings.length === 0 ? 'full' : 'partial') : 'none';
  return { valid, errors, warnings, level };
}

/**
 * Generate a cross-runtime compatibility report for a skill.
 * Pure - testable.
 */
export function crossRuntimeReport(skill: {
  name: string;
  hasSkillMd: boolean;
  hasScripts: boolean;
  hasReferences: boolean;
  hasAssets: boolean;
  entryLanguage?: string;
}): string {
  const lines = [`Skill: ${skill.name}`];
  lines.push(`  SKILL.md: ${skill.hasSkillMd ? '✅' : '❌'} (required)`);
  lines.push(`  scripts/: ${skill.hasScripts ? '✅' : '⚠️ optional'}`);
  lines.push(`  references/: ${skill.hasReferences ? '✅' : '⚠️ optional'}`);
  lines.push(`  assets/: ${skill.hasAssets ? '✅' : '⚠️ optional'}`);
  if (skill.entryLanguage) lines.push(`  entry: ${skill.entryLanguage}`);
  const compatible = skill.hasSkillMd;
  lines.push(`  Cross-runtime: ${compatible ? '✅ compatible with Agent Skills spec' : '❌ not compatible'}`);
  return lines.join('\n');
}
