/**
 * @hmharness/lsp - server registry + discovery
 *
 * First-batch servers per the 03 方案: TypeScript/JavaScript, Pyright,
 * rust-analyzer, gopls, clangd. Discovery is PATH-ONLY and recorded with
 * provenance — automatic downloads are explicitly NOT done here (supply
 * chain; source allowlist + sha256 is the Capability OS layer's job).
 * ArkTS: prefer official/DevEco-local servers when present; community
 * servers are returned with an explicit `unofficial` flag.
 */
import { spawnSync } from 'node:child_process';
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
}

/** Discover available first-batch servers on THIS machine (PATH only).
 *  Memoized — the registry is probed per tool assembly and per spawn. */
let discoveryCache: DiscoveredServer[] | null = null;
export function discoverServers(force = false): DiscoveredServer[] {
  if (!force && discoveryCache) return discoveryCache;
  const out: DiscoveredServer[] = [];
  for (const k of KNOWN) {
    const path = which(k.command);
    if (!path) continue;
    out.push({ id: k.id, command: path, args: k.args, source: 'PATH', languages: k.languages, official: k.official !== false });
  }
  discoveryCache = out;
  return out;
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
