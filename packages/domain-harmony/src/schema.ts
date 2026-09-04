/**
 * @hmh/domain-harmony - schema (config validation)
 * Structural validation for the three project config files hvigor reads:
 *   <module>/src/main/module.json5   - the module manifest (name/type/abilities...)
 *   <module>/build-profile.json5    - module build config (apiType/targets...)
 *   build-profile.json5 (root)      - app products + compatibleSdkVersion
 *
 * Why: when a scaffold edit, agent patch, or hand edit breaks one of these,
 * hvigor fails deep in the build with cryptic messages. Validating structure
 * BEFORE the build turns a 3-minute toolchain failure into a millisecond
 * "module.json5: module.type must be one of entry/feature/har/shared" that
 * names the exact field. Deliberately structural (field presence, types,
 * enums) - semantic build rules stay with hvigor; this is a lint, not a
 * reimplementation.
 *
 * JSON5 tolerance: these files officially allow comments and trailing
 * commas; the parser strips both leniently (line-safe for strings).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tool } from '@hmh/kernel';

/* ---------------- lenient JSON5 parse ---------------- */

/** Parse near-JSON5: strips // and /* comments and trailing commas outside
 *  strings, converts single-quoted strings to double, then JSON.parse.
 *  Not a full JSON5 parser - sufficient for the config shapes DevEco
 *  actually emits. */
export function parseJson5(text: string): unknown {
  let out = '';
  let inStr: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const prev = text[i - 1];
    if (inStr) {
      // close-quote: convert ' -> " (escape-aware); everything else passes
      if (ch === inStr && prev !== '\\') { inStr = null; out += '"'; continue; }
      // a raw double quote inside a single-quoted string must be escaped
      if (ch === '"' && inStr === "'" && prev !== '\\') { out += '\\"'; continue; }
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; out += '"'; continue; }
    if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (ch === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += ch;
  }
  // trailing commas outside strings
  out = out.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(out);
}

/* ---------------- field-level checks ---------------- */

export interface SchemaIssue {
  file: string;
  field: string;
  problem: string;
}

const MODULE_TYPES = new Set(['entry', 'feature', 'har', 'shared']);

export function validateModuleJson5(obj: unknown, file: string): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const m = (obj as { module?: Record<string, unknown> })?.module;
  if (!m || typeof m !== 'object') return [{ file, field: 'module', problem: 'missing "module" object' }];
  if (typeof m.name !== 'string' || !m.name) issues.push({ file, field: 'module.name', problem: 'missing or empty' });
  if (typeof m.type !== 'string' || !MODULE_TYPES.has(m.type)) {
    issues.push({ file, field: 'module.type', problem: `must be one of ${[...MODULE_TYPES].join('/')}, got ${JSON.stringify(m.type)}` });
  }
  if (m.type === 'entry') {
    if (typeof m.mainElement !== 'string' || !m.mainElement) issues.push({ file, field: 'module.mainElement', problem: 'entry modules must name a mainElement (the launch ability)' });
    if (!Array.isArray(m.deviceTypes) || m.deviceTypes.length === 0) issues.push({ file, field: 'module.deviceTypes', problem: 'entry modules need a non-empty deviceTypes array' });
  }
  if (m.pages !== undefined && typeof m.pages !== 'string') issues.push({ file, field: 'module.pages', problem: 'must be a $profile reference string' });
  if (m.abilities !== undefined && !Array.isArray(m.abilities)) issues.push({ file, field: 'module.abilities', problem: 'must be an array' });
  return issues;
}

export function validateBuildProfile(obj: unknown, file: string, kind: 'root' | 'module'): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const o = obj as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return [{ file, field: '(root)', problem: 'not a JSON object' }];
  if (kind === 'root') {
    const app = o.app as Record<string, unknown> | undefined;
    if (!app) return [{ file, field: 'app', problem: 'root build-profile needs an "app" section' }];
    const products = app.products;
    if (!Array.isArray(products) || products.length === 0) issues.push({ file, field: 'app.products', problem: 'needs at least one product' });
    for (const [i, p] of (Array.isArray(products) ? products : []).entries()) {
      const prod = p as Record<string, unknown>;
      if (typeof prod.compatibleSdkVersion !== 'string' || !prod.compatibleSdkVersion) {
        issues.push({ file, field: `app.products[${i}].compatibleSdkVersion`, problem: 'missing (e.g. "6.1.1(24)" or "5.0.5(17)")' });
      }
    }
    if (!Array.isArray(o.modules) || o.modules.length === 0) issues.push({ file, field: 'modules', problem: 'root build-profile needs a non-empty modules array' });
  } else {
    if (o.apiType !== undefined && o.apiType !== 'stageMode') issues.push({ file, field: 'apiType', problem: `expected "stageMode", got ${JSON.stringify(o.apiType)}` });
    if (!Array.isArray(o.targets) || o.targets.length === 0) issues.push({ file, field: 'targets', problem: 'module build-profile needs a non-empty targets array' });
  }
  return issues;
}

/* ---------------- project-wide check ---------------- */

export interface SchemaReport {
  checked: number;
  issues: SchemaIssue[];
}

/** Validate all module.json5 + build-profile.json5 files under a project
 *  root (scans each module dir's src/main/module.json5 and
 *  build-profile.json5 plus the root build-profile). Read-only. */
export async function checkProjectSchemas(root: string): Promise<SchemaReport> {
  const { readdir } = await import('node:fs/promises');
  const issues: SchemaIssue[] = [];
  let checked = 0;

  const rootProfile = join(root, 'build-profile.json5');
  if (await exists(rootProfile)) {
    checked++;
    try {
      const obj = parseJson5(await readFile(rootProfile, 'utf8'));
      issues.push(...validateBuildProfile(obj, rootProfile, 'root'));
    } catch (err) {
      issues.push({ file: rootProfile, field: '(parse)', problem: `unparseable JSON5: ${String(err).slice(0, 90)}` });
    }
  }

  let dirs: string[] = [];
  try {
    dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => join(root, d.name));
  } catch { /* no root */ }
  for (const dir of dirs) {
    // a module dir is one WITH a src/main/module.json5 or a build-profile;
    // everything else (AppScope, hvigor, .git...) is skipped silently -
    // a missing file is not a schema issue
    const mp = join(dir, 'src', 'main', 'module.json5');
    if (await exists(mp)) {
      checked++;
      try {
        const obj = parseJson5(await readFile(mp, 'utf8'));
        issues.push(...validateModuleJson5(obj, mp));
      } catch (err) {
        issues.push({ file: mp, field: '(parse)', problem: `unparseable JSON5: ${String(err).slice(0, 90)}` });
      }
    }
    const bp = join(dir, 'build-profile.json5');
    if (await exists(bp)) {
      checked++;
      try {
        const obj = parseJson5(await readFile(bp, 'utf8'));
        issues.push(...validateBuildProfile(obj, bp, 'module'));
      } catch (err) {
        issues.push({ file: bp, field: '(parse)', problem: `unparseable JSON5: ${String(err).slice(0, 90)}` });
      }
    }
  }
  return { checked, issues };
}

async function exists(p: string): Promise<boolean> {
  try {
    await (await import('node:fs/promises')).stat(p);
    return true;
  } catch {
    return false;
  }
}

/* ---------------- tool registration ---------------- */

export const harmonySchemaCheck: Tool = {
  name: 'harmony_schema_check',
  description:
    'Validate a HarmonyOS project\'s config structure (module.json5 / build-profile.json5) BEFORE building - field presence, enums, product SDK versions. Turns a cryptic 3-minute hvigor failure into a millisecond message naming the exact broken field. Read-only. Run after scaffolding edits, patches, or hand edits; fix what it lists, then harmony_build.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'project root (default: cwd)' },
    },
    required: [],
  },
  needsApproval: () => false,
  async execute(args, ctx) {
    const { resolve } = await import('node:path');
    const root = resolve(ctx.cwd, String(args.path ?? '.'));
    let report: SchemaReport;
    try {
      report = await checkProjectSchemas(root);
    } catch (err) {
      return { output: `schema check failed: ${String(err).slice(0, 160)}`, isError: true };
    }
    if (report.checked === 0) {
      return { output: `no config files found under ${root} - is this a HarmonyOS project root?`, isError: true };
    }
    if (report.issues.length === 0) {
      return { output: `OK: ${report.checked} config file(s) valid (structure + enums). Safe to harmony_build.` };
    }
    const lines = report.issues.map((i) => `- ${i.file} :: ${i.field} - ${i.problem}`);
    return { output: `${report.issues.length} issue(s) in ${report.checked} file(s):\n${lines.join('\n')}\n\nFix these before harmony_build - each names the exact field.`, isError: true };
  },
};
