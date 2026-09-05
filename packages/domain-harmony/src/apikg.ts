/**
 * @hmh/domain-harmony - apikg (API knowledge graph, the codelin api_kg gap)
 * The agent guesses HarmonyOS APIs because it cannot SEE the SDK. The
 * declarations are right there on disk (ets/api/*.d.ts, 927 files) - this
 * module indexes them ONCE into HMH_HOME/apikg and answers lookups with
 * EVIDENCE: the declaration snippet + file:line + kit membership, so a
 * wrong API name is caught by "not in the SDK" instead of hallucinated.
 *
 * Index shape (one JSON per run, rebuilt when the SDK mtime changes):
 *   symbols: { name -> [{ module, kind, kit, file, line, snippet }] }
 * kinds: namespace(declare module), interface, class, enum, type, function,
 *        const, method, property. Methods index under "Class.method".
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tool } from '@hmh/kernel';

export interface ApiSymbolEntry {
  module: string;      // @ohos.xxx
  kind: string;
  kit: string;         // from the /** @kit X */ tag
  file: string;
  line: number;
  snippet: string;     // first ~300 chars of the declaration
}

export interface ApiIndex {
  builtAt: string;
  sdkPath: string;
  sdkMtime: number;
  symbolCount: number;
  symbols: Record<string, ApiSymbolEntry[]>;
}

export function sdkApiDir(devecoHome: string): string {
  return join(devecoHome, 'sdk', 'default', 'openharmony', 'ets', 'api');
}

/* ---------------- parsing ---------------- */

function extractKit(text: string): string {
  const m = text.match(/@kit\s+([A-Za-z0-9]+)/);
  return m ? m[1] : '';
}

/** Parse one d.ts into symbols. Deliberately line-based and tolerant -
 *  d.ts is regular enough that declaration headers live on single lines. */
export function parseDeclaration(file: string, relModule: string, text: string): Array<[string, ApiSymbolEntry]> {
  const kit = extractKit(text);
  const out: Array<[string, ApiSymbolEntry]> = [];
  const lines = text.split('\n');
  const declRe = /^(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(interface|class|enum|type|const|namespace|module)\s+([A-Za-z_$][\w$]*)?/;
  let currentName = '';
  let currentKind = '';
  let currentStart = -1;
  const push = (end: number) => {
    if (!currentName || currentStart < 0) return;
    const snippet = lines.slice(currentStart, Math.min(end, currentStart + 12)).join('\n').slice(0, 320);
    out.push([currentName, { module: relModule, kind: currentKind, kit, file, line: currentStart + 1, snippet }]);
  };
  for (let i = 0; i < lines.length; i++) {
    const m = declRe.exec(lines[i]);
    if (m) {
      push(i); // close previous
      currentKind = m[1];
      currentName = m[2] ?? '';
      currentStart = i;
      continue;
    }
    // methods/props inside a class/interface/namespace: foo(...): X; / foo: X;
    // and namespace-level "function foo(...)" - both indented members
    if (currentName && currentStart >= 0 && i > currentStart) {
      const mm = /^\s{2,}(?:static\s+|readonly\s+|function\s+|const\s+|get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\??\s*[(:=]/.exec(lines[i]);
      if (mm && !/^(constructor|declare|export)$/.test(mm[1]) && !/^\/\//.test(lines[i])) {
        const member = `${currentName}.${mm[1]}`;
        const isFn = /^\s{2,}function\s/.test(lines[i]) || lines[i].includes('(');
        const snippet = lines[i].trim().slice(0, 200);
        out.push([member, { module: relModule, kind: isFn ? 'function' : 'member', kit, file, line: i + 1, snippet }]);
      }
    }
    // top-level (unindented) exported functions inside a namespace body get
    // caught by the member branch above via their 4-space indent in d.ts
  }
  push(lines.length);
  return out;
}

/* ---------------- index build ---------------- */

export async function buildApiIndex(devecoHome: string, cacheDir: string): Promise<ApiIndex> {
  const apiDir = sdkApiDir(devecoHome);
  // SDK identity = newest mtime among the api dir's entries
  let sdkMtime = 0;
  try {
    for (const e of await readdir(apiDir)) {
      const m = (await stat(join(apiDir, e))).mtimeMs;
      if (m > sdkMtime) sdkMtime = m;
    }
  } catch { /* no SDK */ }
  const indexFile = join(cacheDir, 'apikg.json');
  try {
    const prev = JSON.parse(await readFile(indexFile, 'utf8')) as ApiIndex;
    if (prev.sdkMtime === sdkMtime && prev.symbolCount > 0) return prev; // fresh
  } catch { /* rebuild */ }
  const symbols: Record<string, ApiSymbolEntry[]> = {};
  let files = 0;
  try {
    files = (await readdir(apiDir)).filter((f) => f.endsWith('.d.ts') || f.endsWith('.d.ets')).length;
  } catch { /* none */ }
  for (const f of (await readdir(apiDir).catch(() => [] as string[]))) {
    if (!/\.d\.(ts|ets)$/.test(f)) continue;
    const text = await readFile(join(apiDir, f), 'utf8');
    const relModule = f.replace(/\.d\.(ts|ets)$/, '');
    for (const [name, entry] of parseDeclaration(f, relModule, text)) {
      (symbols[name] ??= []).push(entry);
    }
  }
  const index: ApiIndex = {
    builtAt: new Date().toISOString(),
    sdkPath: apiDir,
    sdkMtime,
    symbolCount: Object.keys(symbols).length,
    symbols,
  };
  await mkdir(cacheDir, { recursive: true });
  await writeFile(indexFile, JSON.stringify(index), 'utf8');
  return index;
}

/** Load the index (building it on first use / SDK change). */
export async function loadApiIndex(devecoHome: string, home: string): Promise<ApiIndex | null> {
  try {
    return await buildApiIndex(devecoHome, join(home, 'apikg'));
  } catch {
    return null;
  }
}

export interface LookupResult {
  query: string;
  exact: Array<ApiSymbolEntry>;
  fuzzy: Array<{ name: string; entry: ApiSymbolEntry }>;
  totalSymbols: number;
}

export function lookupSymbol(index: ApiIndex, query: string, limit = 4): LookupResult {
  const q = query.trim();
  const exact = (index.symbols[q] ?? []).slice(0, limit);
  const fuzzy: Array<{ name: string; entry: ApiSymbolEntry }> = [];
  const lower = q.toLowerCase();
  for (const [name, entries] of Object.entries(index.symbols)) {
    if (name.toLowerCase().includes(lower) && name !== q) {
      for (const entry of entries.slice(0, 1)) fuzzy.push({ name, entry });
      if (fuzzy.length >= limit) break;
    }
  }
  return { query: q, exact, fuzzy, totalSymbols: index.symbolCount };
}

/* ---------------- tool ---------------- */

export const harmonyApiLookup: Tool = {
  name: 'harmony_api_lookup',
  description:
    'Look up a HarmonyOS/ArkTS API symbol in the ACTUAL local SDK declarations (927 d.ts files indexed) - returns the declaration snippet with file:line evidence and kit membership. Use BEFORE writing code that calls any @ohos API: confirms the symbol exists, its exact signature context, and which kit it belongs to. A miss means "not in this SDK" - do not guess, reconsider the name or check the docs.',
  parameters: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'symbol name, e.g. "UIAbility", "hilog.info" (hierarchical too), "Want"' },
    },
    required: ['symbol'],
  },
  needsApproval: () => false, // read-only; first call builds the local index
  async execute(args) {
    const { homedir } = await import('node:os');
    const deveco = process.env.HM_DEVECO_HOME ?? 'C:\\DevEco-Studio';
    const home = process.env.HMH_HOME ?? join(homedir(), '.hmharness');
    const index = await loadApiIndex(deveco, home);
    if (!index || index.symbolCount === 0) {
      return { output: `SDK declarations not found at ${sdkApiDir(deveco)} - set HM_DEVECO_HOME.`, isError: true };
    }
    const raw = String(args.symbol ?? '').trim();
    if (!raw) return { output: 'symbol required', isError: true };
    // support "hilog.info" - namespace.method form: try full, then the tail
    const tries = [raw];
    if (raw.includes('.')) tries.push(raw.split('.').pop()!);
    let best: LookupResult | null = null;
    for (const t of tries) {
      const r = lookupSymbol(index, t);
      if (r.exact.length > 0) { best = r; break; }
      if (!best) best = r;
    }
    const r = best!;
    if (r.exact.length === 0 && r.fuzzy.length === 0) {
      return { output: `"${raw}" not found in the local SDK index (${r.totalSymbols} symbols). The symbol does not exist in THIS SDK version - do not guess; check the docs or reconsider the name.`, isError: true };
    }
    const fmt = (e: ApiSymbolEntry, name?: string) => `  ${name ? name + ' ' : ''}[${e.kind}${e.kit ? ' · ' + e.kit : ''}] ${e.module} :: ${e.file}:${e.line}\n${e.snippet}`;
    const lines = [
      `query: ${raw} (index: ${r.totalSymbols} symbols, built ${index.builtAt.slice(0, 10)})`,
      ...r.exact.map((e) => fmt(e)),
      ...(r.fuzzy.length ? ['', 'similar:', ...r.fuzzy.map((f) => fmt(f.entry, f.name))] : []),
    ];
    return { output: lines.join('\n') };
  },
};
