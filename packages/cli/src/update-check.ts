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
// 5 minutes for auto-update mode (fresh enough to catch new releases same-session);
// the check is a single lightweight GET, not worth caching longer
const CACHE_TTL_MS = 5 * 60_000;

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

/** Background self-update (product direction 2026-09-21: zero-action updates,
 *  notify only). NEVER swaps files under the running process - npm runs
 *  detached and the new version is picked up on the NEXT launch, so a
 *  mid-session install cannot corrupt the live TUI (Windows also locks
 *  files in use, and this machine EPERMs on locked writes). A lock file
 *  keeps concurrent hmh instances from racing one npm install. */
export async function autoUpdate(opts: {
  home: string;
  current: string;
  say: (line: string) => void;
  sayFail?: (line: string) => void;
  spawnImpl?: (cmd: string, args: string[], o: { detached: boolean; stdio: unknown; cwd: string }) => { unref: () => void };
  now?: number;
}): Promise<void> {
  try {
    const info = await checkForUpdate({ home: opts.home, current: opts.current, now: opts.now });
    if (!info) return;
    const { open } = await import('node:fs/promises');
    const lockFile = join(opts.home, 'updating.lck');
    const now = opts.now ?? Date.now();
    try {
      const prev = JSON.parse(await readFile(lockFile, 'utf8')) as { time: number };
      if (now - prev.time < 10 * 60_000) {
        opts.say?.(info.latest + ' (another hmh is already updating)');
        return;
      }
    } catch { /* no lock */ }
    await mkdir(opts.home, { recursive: true });
    const log = await open(join(opts.home, 'update.log'), 'a');
    const spawnFn = opts.spawnImpl ?? ((await import('node:child_process')).spawn);
    const child = spawnFn('npm', ['install', '-g', '@hmharness/cli@' + info.latest, '--registry=https://registry.npmjs.org/', '--no-fund', '--no-audit'], {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      cwd: opts.home,
    });
    child.unref();
    await writeFile(lockFile, JSON.stringify({ time: now, to: info.latest }), 'utf8');
    opts.say(info.latest);
  } catch (err) {
    opts.sayFail?.(String(err).slice(0, 80));
  }
}
