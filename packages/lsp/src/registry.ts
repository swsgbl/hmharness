/**
 * @hmharness/lsp - server registry + discovery
 *
 * First-batch servers per the 03 方案: TypeScript/JavaScript, Pyright,
 * rust-analyzer, gopls, clangd. Discovery is PATH-ONLY plus DEVECO-LOCAL
 * (the IDE ships a real clangd under tools/llvm/server/lsp — an official
 * source we prefer over community downloads). Automatic downloads are
 * explicitly NOT done here (supply chain; source allowlist + sha256 is the
 * Capability OS layer's job). ArkTS: prefer official/DevEco-local servers
 * when present; community servers are returned with an explicit
 * `unofficial` flag.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ServerSpec } from './process-manager.ts';

interface KnownServer {
  id: string;
  command: string;
  args: string[];
  /** languages this server indexes (used by tools to pick a server for a file) */
  languages: string[];
  official?: boolean; // false = community fallback (flagged in tool output)
}

const KNOWN: KnownServer[] = [
  { id: 'typescript', command: 'typescript-language-server', args: ['--stdio'], languages: ['typescript', 'javascript'], official: true },
  { id: 'pyright', command: 'pyright-langserver', args: ['--stdio'], languages: ['python'], official: true },
  { id: 'rust-analyzer', command: 'rust-analyzer', args: [], languages: ['rust'], official: true },
  { id: 'gopls', command: 'gopls', args: [], languages: ['go'], official: true },
  { id: 'clangd', command: 'clangd', args: [], languages: ['c', 'cpp'], official: true },
  // ArkTS: community fallback only — 03 方案: 官方/DevEco 本地服务优先，
  // 社区 server 必须明确标注
  { id: 'arkts-community', command: 'arkts-language-server', args: ['--stdio'], languages: ['arkts'], official: false },
];

function which(cmd: string): string | null {
  const probe = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `where ${cmd}`], { encoding: 'utf8', timeout: 5_000, windowsHide: true })
    : spawnSync('which', [cmd], { encoding: 'utf8', timeout: 5_000 });
  if (probe.status !== 0) return null;
  const first = (probe.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean)[0];
  return first ?? null;
}

export interface DiscoveredServer extends ServerSpec {
  languages: string[];
  official: boolean;
  /** probe result: a shim whose toolchain lacks the component (e.g. rustup
   *  without rust-analyzer installed) fails --version and must not register */
  healthy: boolean;
  unhealthyReason?: string;
  /** where this server came from: PATH | PATH-community | DevEco-local | DevEco-local-community */
  origin: string;
}

/** DevEco Studio install roots to scan for bundled (official) servers. */
export const DEVECO_ROOTS = [
  'C:/Program Files/Huawei/DevEco Studio',
  'D:/Program Files/Huawei/DevEco Studio',
  process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA + '/Huawei/DevEco Studio' : '',
].filter(Boolean);

/** well-known bundled-server layouts inside a DevEco install (03 方案:
 *  优先发现 DevEco/SDK 本地服务,记录来源——绝不自动下载) */
function devecoBundled(devecoRoots: string[]): Array<{ id: string; command: string; args: string[]; languages: string[]; official: boolean; origin: string }> {
  const out: Array<{ id: string; command: string; args: string[]; languages: string[]; official: boolean; origin: string }> = [];
  for (const root of devecoRoots) {
    // clangd ships with the IDE's native toolchain (versioned per release)
    const clangd = root + '/tools/llvm/server/lsp/win/clangd.exe';
    if (existsSync(clangd)) out.push({ id: 'clangd', command: clangd, args: [], languages: ['c', 'cpp'], official: true, origin: 'DevEco-local' });
  }
  return out;
}

/** Cheap health probe: `--version` must exit 0 within 5s. A PATH shim whose
 *  toolchain lacks the component (rustup without rust-analyzer installed)
 *  fails here — better an absent tool than a dead one registered. */
function healthProbe(command: string, args: string[]): { healthy: boolean; reason?: string } {
  const r = spawnSync(command, [...args, '--version'], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
  if (r.status === 0) return { healthy: true };
  const tail = ((r.stderr || '') + (r.stdout || '')).trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
  return { healthy: false, reason: `--version probe failed (exit ${r.status}): ${tail.slice(0, 120)}` };
}

/** Discover available servers on THIS machine (PATH + DevEco-local).
 *  Memoized — the registry is probed per tool assembly and per spawn.
 *  Health-probed: broken shims are returned with healthy=false so callers
 *  can skip registering them (discovery stays honest about what exists). */
let discoveryCache: DiscoveredServer[] | null = null;
export function discoverServers(force = false, opts: { devecoRoots?: string[] } = {}): DiscoveredServer[] {
  if (!force && discoveryCache) return discoveryCache;
  const out: DiscoveredServer[] = [];
  const seen = new Map<string, DiscoveredServer>();
  const push = (id: string, command: string, args: string[], languages: string[], official: boolean, origin: string, probe: boolean) => {
    const h = probe ? healthProbe(command, args) : { healthy: true as const };
    const entry: DiscoveredServer = { id, command, args, source: origin.includes('DevEco') ? 'explicit' : 'PATH', languages, official, healthy: h.healthy, unhealthyReason: (h as { reason?: string }).reason, origin };
    // first (preferred) source wins per id: DevEco-local beats PATH beats community
    const existing = seen.get(id);
    if (!existing || (existing.origin.includes('community') && !origin.includes('community'))) {
      seen.set(id, entry);
    }
  };
  // PATH servers
  for (const k of KNOWN) {
    const path = which(k.command);
    if (!path) continue;
    push(k.id, path, k.args, k.languages, k.official !== false, k.official !== false ? 'PATH' : 'PATH-community', true);
  }
  // DevEco-local bundled servers (official, no download ever)
  for (const b of devecoBundled(opts.devecoRoots ?? DEVECO_ROOTS)) {
    push(b.id, b.command, b.args, b.languages, b.official, b.origin, true);
  }
  discoveryCache = [...seen.values()];
  return discoveryCache;
}

/** Pick the server responsible for a file uri/path by extension. */
export function serverForFile(servers: DiscoveredServer[], file: string): DiscoveredServer | null {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  const langByExt: Record<string, string> = { ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', mjs: 'javascript', cjs: 'javascript', py: 'python', rs: 'rust', go: 'go', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', ets: 'arkts' };
  const lang = langByExt[ext];
  if (!lang) return null;
  return servers.find((s) => s.languages.includes(lang)) ?? null;
}

export function fileToUri(absPath: string): string {
  const norm = absPath.replace(/\\/g, '/');
  return 'file:///' + norm.replace(/^([A-Za-z]):/, '$1:').replace(/^\/+/, '');
}
