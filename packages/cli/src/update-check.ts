/**
 * @hmharness/cli - update-check
 * npm is pull-based: there is no server-side push. The honest "update
 * reminder" is a client-side version check against the registry's latest
 * dist-tag, printed once per interactive session - never blocking startup,
 * never nagging offline, results cached for a day.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const REGISTRY = 'https://registry.npmjs.org/-/package/@hmharness/cli/dist-tags';
const CACHE_TTL_MS = 24 * 3600_000;

/** Numeric per-component semver compare (no dependency, dot-split).
 *  Prerelease suffixes degrade to their leading number ('1-beta' -> 1) -
 *  good enough for an update hint, never claims to be full semver. */
export function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

export interface UpdateInfo {
  current: string;
  latest: string;
}

/** Returns info when a NEWER version exists on the registry, else null.
 *  Cache-first: a fresh (<24h) cached latest answer means zero network. */
export async function checkForUpdate(opts: {
  home: string;
  current: string;
  now?: number;
  fetchImpl?: typeof fetch;
}): Promise<UpdateInfo | null> {
  const now = opts.now ?? Date.now();
  const cacheFile = join(opts.home, 'update-check.json');
  let latest: string | null = null;

  try {
    const c = JSON.parse(await readFile(cacheFile, 'utf8')) as { time: number; latest: string };
    if (typeof c.latest === 'string' && now - c.time < CACHE_TTL_MS) latest = c.latest;
  } catch { /* no cache yet */ }

  if (latest === null) {
    const doFetch = opts.fetchImpl ?? fetch;
    try {
      const res = await doFetch(REGISTRY, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const tags = await res.json() as { latest?: string };
        if (typeof tags.latest === 'string') {
          latest = tags.latest;
          try {
            await mkdir(opts.home, { recursive: true });
            await writeFile(cacheFile, JSON.stringify({ time: now, latest }), 'utf8');
          } catch { /* cache write is best-effort */ }
        }
      }
    } catch { /* offline / slow registry: silent, never nag */ }
  }

  if (latest === null || cmpSemver(opts.current, latest) >= 0) return null;
  return { current: opts.current, latest };
}

/** Fire-and-forget wrapper for interactive frontends: resolve-and-say, or
 *  say nothing at all. Never rejects. */
export async function notifyUpdate(home: string, current: string, say: (line: string) => void): Promise<void> {
  try {
    const info = await checkForUpdate({ home, current });
    if (info) say(info.latest);
  } catch { /* never surface update-check failures */ }
}
