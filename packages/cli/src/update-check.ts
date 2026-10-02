/**
 * @hmharness/cli - update-check
 * npm is pull-based: there is no server-side push. The honest "update
 * reminder" is a client-side version check against the registry's latest
 * dist-tag, printed once per interactive session - never blocking startup,
 * never nagging offline, results cached for a day.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

/** Background self-update (product direction 2026-09-21: zero-action updates;
 *  2026-09-25 redesign: SMART update; 2026-10-02 T27/T28: fully silent +
 *  board channel).
 *
 *  The old version hard-coded `spawn('npm', ...)` - which (a) silently fails
 *  on Windows since Node 18.20 refuses to spawn .cmd shims without a shell,
 *  while the UI still claimed "已在后台自动更新", (b) leaked the log
 *  FileHandle (DEP0137 GC-close warnings on every startup), and (c) opened a
 *  VISIBLE console window for every background install (the "update popup").
 *
 *  The design adapts instead of hard-coding, three layers deep:
 *   0. board installs (KaihongOS/OpenHarmony, <home>/.local/hmharness
 *      layout, NO npm) update through the SHIPPED board installer script -
 *      deterministic, idempotent, registry-driven with offline pins (T28);
 *   1. buildUpdateCommand() picks the launcher per platform (cmd.exe shell
 *      escape on win32, direct exec elsewhere) - the SAME JS runs everywhere;
 *   2. if the standard install fails to even start, aiRepairUpdate() asks the
 *      user's configured chat model for ONE corrective install command based
 *      on the real error + environment facts, validates it against an
 *      allow/deny filter and runs it detached. That is the "AI-driven" layer:
 *      the model adapts to the machine, not our code.
 *  Every spawn is detached + windowsHide (T27): updates are INVISIBLE -
 *  success says nothing (the header version changes on the next launch),
 *  only a failed install may print one dim line. A lock file keeps
 *  concurrent hmh instances from racing one install. */

export interface UpdateLaunch {
  file: string;
  args: string[];
  /** shell:true semantics are needed when the package manager is a .cmd shim */
  shellEscaped: boolean;
}

/** True when the CLI runs from a KaihongOS/OpenHarmony board layout
 *  (<home>/.local/hmharness/node_modules/@hmharness/cli/dist) - the layout
 *  scripts/board/install-kaihongos.cjs creates. npm does not exist there and
 *  the npm-shaped AI-repair whitelist can never produce a legal board
 *  command, so updates take the deterministic board-installer path instead
 *  (settled design T28). Pure; tested. */
export function isBoardInstall(distDir: string): boolean {
  const d = distDir.replace(/\\/g, '/').replace(/\/+$/, '');
  return /\/\.local\/hmharness\/node_modules\/@hmharness\/cli\/dist$/.test(d);
}

/** The board home for a board-layout dist dir ('' when not a board install).
 *  <home> is the segment BEFORE /.local/hmharness - exactly what the
 *  installer's --home flag wants. Pure; tested. */
export function boardHomeFromDistDir(distDir: string): string {
  if (!isBoardInstall(distDir)) return '';
  const d = distDir.replace(/\\/g, '/');
  const at = d.indexOf('/.local/hmharness/');
  return at > 0 ? d.slice(0, at) : '/';
}

/** Platform-correct launcher for `npm install -g @hmharness/cli@<v>`.
 *  Pure; tested. */
export function buildUpdateCommand(platform: string, version: string): UpdateLaunch {
  const installArgs = ['install', '-g', '@hmharness/cli@' + version, '--registry=https://registry.npmjs.org/', '--no-fund', '--no-audit'];
  if (platform === 'win32') {
    // Node >= 18.20 throws EINVAL when spawning .cmd shims without a shell -
    // route through cmd.exe explicitly
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', 'npm ' + installArgs.join(' ')], shellEscaped: true };
  }
  return { file: 'npm', args: installArgs, shellEscaped: false };
}

/** Model-proposed commands must be an install/update OF THE CLI PACKAGE and
 *  must not touch anything else. Pure; tested. */
export function isSafeUpdateCommand(cmd: string): boolean {
  const c = cmd.trim();
  if (!/^(npm|pnpm|bun|yarn|corepack|node)\b/i.test(c)) return false;
  if (/\brm\s|-rf\b|\bsudo\b|\bdel\s|\bformat\s|shutdown|reboot|mkfs|\bdd\s|\/etc\/|curl[^|]*\|\s*(ba)?sh/i.test(c)) return false;
  return /@hmharness\/cli/i.test(c);
}

/** The environment fact sheet handed to the model for AI repair - everything
 *  it needs to diagnose an exotic setup (nvm dir, pnpm global, EPERM...). */
export function updateEnvFacts(platform: string, execPath: string, distDir: string, error: string): string {
  return [
    'platform=' + platform,
    'node=' + process.version,
    'execPath=' + execPath,
    'cliDist=' + distDir,
    'error=' + error.slice(0, 400),
  ].join('\n');
}

/** One AI attempt to fix a failed self-update. Returns the command it ran
 *  (already spawned detached), or null when the model/answer is unusable.
 *  chatImpl is injectable for tests. */
export async function aiRepairUpdate(opts: {
  home: string;
  platform: string;
  execPath: string;
  distDir: string;
  error: string;
  version: string;
  chatImpl?: (prompt: string) => Promise<string>;
  spawnImpl?: (cmd: string, args: string[], o: { detached: boolean; stdio: unknown; cwd: string; windowsHide?: boolean }) => { unref: () => void; on: (ev: string, fn: () => void) => void };
  logFd: number;
}): Promise<string | null> {
  try {
    const chat = opts.chatImpl ?? (async () => {
      const kernel = await import('@hmharness/kernel');
      const cfg = await kernel.loadConfig();
      const provider = kernel.resolveProvider(cfg, 'chat');
      const r = await kernel.chat(provider, [
        { role: 'system', content: 'You fix package-manager installs. Reply with STRICT JSON {"command":"<one shell command>"} - a single install/update command for the @hmharness/cli package (npm/pnpm/bun/yarn/corepack). No other text, no markdown fence. Never destructive.' },
        { role: 'user', content: 'The standard "npm install -g @hmharness/cli@' + opts.version + '" failed on this machine:\n' + opts.error + '\n\nEnvironment:\n' + updateEnvFacts(opts.platform, opts.execPath, opts.distDir, opts.error) + '\n\nGive the ONE command that installs @hmharness/cli@' + opts.version + ' globally on THIS setup.' },
      ]);
      return r.message?.content ?? '';
    });
    // chat returns RAW model text; the {"command": ...} extraction lives HERE
    // so an injected test chat has the same contract as the real one
    const raw = await chat('fix update');
    const m = /\{[\s\S]*\}/.exec(raw ?? '');
    const cmd = m ? String((JSON.parse(m[0]) as { command?: string }).command ?? '').trim() : '';
    if (!cmd || !isSafeUpdateCommand(cmd)) return null;
    const spawnFn = opts.spawnImpl ?? (await import('node:child_process')).spawn;
    const plat = opts.platform;
    const child = plat === 'win32'
      ? spawnFn('cmd.exe', ['/d', '/s', '/c', cmd], { detached: true, stdio: ['ignore', opts.logFd, opts.logFd], cwd: opts.home, windowsHide: true })
      : spawnFn(cmd.split(' ')[0], cmd.split(' ').slice(1), { detached: true, stdio: ['ignore', opts.logFd, opts.logFd], cwd: opts.home });
    child.unref();
    return cmd;
  } catch {
    return null; // AI repair is best-effort; the hint line still shows
  }
}

/** Wait ~3s for a spawn 'error' (ENOENT/EINVAL fire immediately) so the UI
 *  only claims success when the installer actually started. */
export function spawnStarted(child: { on: (ev: string, fn: () => void) => void }, ms = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    child.on('error', () => done(false));
    setTimeout(() => done(true), ms);
  });
}

export async function autoUpdate(opts: {
  home: string;
  current: string;
  /** failure notice only - success is SILENT by design (T27): the new
   *  version announces itself in the TUI header on the next launch */
  sayFail?: (line: string) => void;
  spawnImpl?: (cmd: string, args: string[], o: { detached: boolean; stdio: unknown; cwd: string; windowsHide?: boolean }) => { unref: () => void; on: (ev: string, fn: () => void) => void };
  now?: number;
  aiChat?: (prompt: string) => Promise<string>;
  /** override the running dist dir (tests inject a board layout) */
  distDir?: string;
  /** registry fetch injection (tests stay hermetic) */
  fetchImpl?: typeof fetch;
}): Promise<void> {
  try {
    const info = await checkForUpdate({ home: opts.home, current: opts.current, now: opts.now, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
    if (!info) return;
    const { open } = await import('node:fs/promises');
    const lockFile = join(opts.home, 'updating.lck');
    const now = opts.now ?? Date.now();
    try {
      const prev = JSON.parse(await readFile(lockFile, 'utf8')) as { time: number };
      if (now - prev.time < 10 * 60_000) {
        return; // another hmh is already updating - silent (T27)
      }
    } catch { /* no lock */ }
    await mkdir(opts.home, { recursive: true });
    const log = await open(join(opts.home, 'update.log'), 'a');
    try {
      const spawnFn = opts.spawnImpl ?? (await import('node:child_process')).spawn;
      // Layer 0 (settled design T28): KaihongOS/OpenHarmony board installs
      // have no npm and no package manager the AI whitelist could ever
      // target - the SHIPPED board installer is the only correct updater.
      // It is idempotent, resolves versions from the registry (offline
      // fallback pins inside), stages + verifies + swaps, and rewrites the
      // launcher. Everything runs detached and hidden; success is silent.
      const distDir = opts.distDir ?? join(import.meta.dirname ?? '.', '');
      if (isBoardInstall(distDir)) {
        const script = join(distDir, '..', 'board', 'install-kaihongos.cjs');
        const bhome = boardHomeFromDistDir(distDir);
        if (bhome && existsSync(script)) {
          const child = spawnFn(process.execPath, [script, '--home=' + bhome], {
            detached: true,
            stdio: ['ignore', log.fd, log.fd],
            cwd: opts.home,
            windowsHide: true, // never flash a console window (T27)
          });
          child.unref();
          await writeFile(lockFile, JSON.stringify({ time: now, to: info.latest, via: 'board-installer' }), 'utf8');
          const started = await spawnStarted(child);
          if (!started) throw new Error('board installer failed to start');
          return; // silent success (T27)
        }
        opts.sayFail?.('board install: updater script missing');
        return;
      }
      const launch = buildUpdateCommand(process.platform, info.latest);
      const child = spawnFn(launch.file, launch.args, {
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
        cwd: opts.home,
        windowsHide: true, // detached cmd.exe/npm MUST NOT open a visible window (T27)
      });
      child.unref();
      await writeFile(lockFile, JSON.stringify({ time: now, to: info.latest }), 'utf8');
      const started = await spawnStarted(child);
      if (!started) throw new Error('installer failed to start');
      // silent success (T27): no notice - the header version changes on the
      // next launch; every detail is in update.log if anyone needs it
    } catch (err) {
      // SMART layer: let the user's own model adapt to this machine
      const errText = String(err).slice(0, 400);
      const distDir = opts.distDir ?? join(import.meta.dirname ?? '.', '');
      const ran = await aiRepairUpdate({
        home: opts.home,
        platform: process.platform,
        execPath: process.execPath,
        distDir,
        error: errText,
        version: info.latest,
        chatImpl: opts.aiChat,
        spawnImpl: opts.spawnImpl,
        logFd: log.fd,
      });
      if (ran) {
        await writeFile(lockFile, JSON.stringify({ time: now, to: info.latest, via: 'ai-repair', cmd: ran }), 'utf8');
      } else {
        opts.sayFail?.(errText.slice(0, 80));
      }
    } finally {
      // the child inherited a dup of this fd; closing ours kills the
      // DEP0137 "closed on garbage collection" startup warnings
      await log.close().catch(() => {});
    }
  } catch (err) {
    opts.sayFail?.(String(err).slice(0, 80));
  }
}
