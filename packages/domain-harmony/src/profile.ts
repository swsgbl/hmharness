/**
 * @hmh/domain-harmony - profile (project picture, quality-trio minimal)
 * A one-call inventory of a HarmonyOS project: modules, pages, abilities,
 * har/hap dependency edges, resource counts, and config health (schema
 * issues inline). Answer "what is this project" without reading 20 files -
 * the base layer the old line's quality trio (profile / regression /
 * scoring) starts from.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Tool } from '@hmh/kernel';
import { parseJson5, checkProjectSchemas } from './schema.ts';

export interface ProjectProfile {
  root: string;
  bundleName: string;
  sdkVersion: string;
  modules: Array<{ name: string; type: string; pages: string[]; abilities: string[]; deviceTypes: string[] }>;
  hapDependencies: string[];
  resourceCounts: { strings: number; media: number };
  sourceFiles: number;
  configIssues: number;
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function countFiles(dir: string, ext: string, maxDepth = 6): Promise<number> {
  let n = 0;
  const stack = [[dir, 0] as [string, number]];
  while (stack.length) {
    const [d, dep] = stack.pop()!;
    if (dep > maxDepth) continue;
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') || ['node_modules', 'oh_modules', 'build', '.hvigor'].includes(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push([p, dep + 1]);
      else if (e.name.endsWith(ext)) n++;
    }
  }
  return n;
}

export async function profileProject(root: string): Promise<ProjectProfile> {
  const r = resolve(root);
  // app scope
  let bundleName = '';
  try {
    const app = parseJson5(await readFile(join(r, 'AppScope', 'app.json5'), 'utf8')) as { app?: { bundleName?: string } };
    bundleName = app.app?.bundleName ?? '';
  } catch { /* no AppScope */ }
  // root build-profile for sdk
  let sdk = '';
  try {
    const bp = parseJson5(await readFile(join(r, 'build-profile.json5'), 'utf8')) as { app?: { products?: Array<{ compatibleSdkVersion?: string }> } };
    sdk = bp.app?.products?.[0]?.compatibleSdkVersion ?? '';
  } catch { /* absent */ }
  // modules
  const modules: ProjectProfile['modules'] = [];
  let entries: Array<{ name: string }> = [];
  try {
    entries = (await readdir(r, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.') && !['AppScope', 'hvigor', 'build', 'oh_modules', 'node_modules', '.hvigor'].includes(d.name)).map((d) => ({ name: d.name }));
  } catch { /* none */ }
  for (const { name } of entries) {
    const mp = join(r, name, 'src', 'main', 'module.json5');
    if (!(await exists(mp))) continue;
    try {
      const m = parseJson5(await readFile(mp, 'utf8')) as { module?: { type?: string; deviceTypes?: string[]; abilities?: Array<{ name: string }> } };
      // pages list from the profile json
      let pages: string[] = [];
      try {
        const pp = parseJson5(await readFile(join(r, name, 'src', 'main', 'resources', 'base', 'profile', 'main_pages.json'), 'utf8')) as { src?: string[] };
        pages = pp.src ?? [];
      } catch { /* no pages (har) */ }
      modules.push({
        name,
        type: m.module?.type ?? '',
        pages,
        abilities: (m.module?.abilities ?? []).map((a) => a.name),
        deviceTypes: m.module?.deviceTypes ?? [],
      });
    } catch { /* unparseable module.json5 - schema check will report it */ }
  }
  // entry's har deps
  let hapDependencies: string[] = [];
  try {
    const pkg = parseJson5(await readFile(join(r, 'entry', 'oh-package.json5'), 'utf8')) as { dependencies?: Record<string, string> };
    hapDependencies = Object.entries(pkg.dependencies ?? {}).map(([k, v]) => `${k}@${v}`);
  } catch { /* none */ }
  const schema = await checkProjectSchemas(r);
  return {
    root: r,
    bundleName,
    sdkVersion: sdk,
    modules,
    hapDependencies,
    resourceCounts: {
      strings: await countFiles(join(r, 'AppScope', 'resources'), '.json') + await countFiles(join(r, 'entry', 'src', 'main', 'resources'), '.json'),
      media: await countFiles(join(r, 'AppScope', 'resources'), '.png') + await countFiles(join(r, 'entry', 'src', 'main', 'resources'), '.png'),
    },
    sourceFiles: await countFiles(r, '.ets'),
    configIssues: schema.issues.length,
  };
}

export const harmonyProjectProfile: Tool = {
  name: 'harmony_project_profile',
  description:
    'One-call project inventory: modules (type/pages/abilities/deviceTypes), har dependencies, resource + source counts, bundle/SDK, and config health (issue count from schema check). The "what is this project" answer without reading files one by one - use before planning changes or estimating scope.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'project root (default: auto-detect from cwd)' },
    },
    required: [],
  },
  needsApproval: () => false,
  async execute(args, ctx) {
    let root = ctx.cwd;
    if (typeof args.path === 'string' && args.path) root = resolve(ctx.cwd, args.path);
    // walk up to the project root marker
    let dir = root;
    for (;;) {
      if (await exists(join(dir, 'build-profile.json5'))) { root = dir; break; }
      const parent = resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
    try {
      const p = await profileProject(root);
      const lines = [
        `project: ${p.root}`,
        `bundle: ${p.bundleName || '(unknown)'} · SDK: ${p.sdkVersion || '(not set)'}`,
        `modules (${p.modules.length}):`,
        ...p.modules.map((m) => `  - ${m.name} [${m.type}] pages:${m.pages.length} abilities:${m.abilities.join(',') || '-'} devices:${m.deviceTypes.join(',') || '-'}`),
        `entry deps: ${p.hapDependencies.join(', ') || '(none)'}`,
        `sources: ${p.sourceFiles} .ets · resources: ${p.resourceCounts.strings} json / ${p.resourceCounts.media} png`,
        `config health: ${p.configIssues === 0 ? 'OK' : `${p.configIssues} issue(s) - run harmony_schema_check for details`}`,
      ];
      return { output: lines.join('\n') };
    } catch (err) {
      return { output: `profile failed: ${String(err).slice(0, 160)}`, isError: true };
    }
  },
};
