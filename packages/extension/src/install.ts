/**
 * @hmharness/extension - PERSISTENT install into the user's real browsers
 *
 * `hmh extension install` puts the extension into every discovered
 * browser's extension list — the real, stays-after-restart kind:
 *
 *  Chromium family (Chrome / Edge / Brave / Opera / Quark / BrowserOS):
 *    the OFFICIAL enterprise channel — an HKCU registry entry per browser
 *    (HKCU\Software\<Vendor>\Extensions\<id>) naming our fixed extension
 *    ID + the STABLE payload folder. The browser loads it on next start,
 *    for every profile, no developer mode needed. This is the same
 *    mechanism IT departments use; we just point it at ourselves.
 *
 *  Firefox (release):
 *    unsigned extensions are normally refused — the sanctioned bypass is
 *    enterprise policy: HKCU\Software\Policies\Mozilla\Firefox\
 *    ExtensionSettings force_installed pointing at a local file:// XPI
 *    (signature checks are policy-bypassed by design for enterprise
 *    deployment).
 *
 *  Payload stability: builds land in HMH_HOME/extension-install/<target>
 *  — NEVER a temp dir — because the registry references the path and
 *  moving/deleting the folder bricks the install (Chromium then disables
 *  the entry with "missing"). Uninstall removes the registry entries and
 *  the folder.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_ID, EXTENSION_VERSION } from './adapters.ts';
import { buildExtension } from './build.ts';

/** Where `hmh extension install` looks for browsers (roots + desktop .lnk). */
export function discoverInstallTargets(): Array<{ name: string; command: string }> {
  const out: Array<{ name: string; command: string }> = [];
  const la = process.env.LOCALAPPDATA ?? '';
  const pf = process.env.ProgramFiles ?? '';
  const roots: Array<[string, string]> = [
    ['chrome', join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['edge', join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['edge', join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['brave', join(la, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')],
    ['opera', join(la, 'Programs', 'Opera', 'opera.exe')],
    ['quark', join(pf, 'Quark', 'quark.exe')],
    ['firefox', join(pf, 'Mozilla Firefox', 'firefox.exe')],
    ['browseros', join(la, 'BrowserOS', 'Application', 'chrome.exe')],
  ];
  for (const [name, p] of roots) {
    if (p && existsSync(p) && !out.some((b) => b.name === name)) out.push({ name, command: p });
  }
  try {
    const desktop = join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'Desktop');
    for (const f of readdirSync(desktop)) {
      if (!f.toLowerCase().endsWith('.lnk')) continue;
      const r = spawnSync('powershell', ['-NoProfile', '-Command',
        `(New-Object -ComObject WScript.Shell).CreateShortcut('${join(desktop, f).replace(/'/g, "''")}').TargetPath`],
        { encoding: 'utf8', timeout: 10_000, windowsHide: true });
      const target = (r.stdout ?? '').trim();
      const base = target.split('\\').pop()?.toLowerCase() ?? '';
      const name = { 'firefox.exe': 'firefox', 'brave.exe': 'brave', 'opera.exe': 'opera', 'quark.exe': 'quark', 'chrome.exe': 'chrome', 'msedge.exe': 'edge' }[base];
      if (name && existsSync(target) && !out.some((b) => b.name === name)) out.push({ name, command: target });
    }
  } catch { /* desktop shortcuts are an optional discovery source */ }
  return out;
}

/** Chromium-family browsers we can persist into + their registry hives. */
export const CHROMIUM_REG_HIVES: Record<string, string> = {
  chrome: 'Software\\Google\\Chrome\\Extensions',
  edge: 'Software\\Microsoft\\Edge\\Extensions',
  brave: 'Software\\BraveSoftware\\Brave-Browser\\Extensions',
  opera: 'Software\\OperaSoftware\\Extensions',
  quark: 'Software\\Quark\\Quark\\Extensions',
  browseros: 'Software\\BrowserOS\\Extensions',
};

export function stableInstallDir(home: string, target: 'chromium' | 'firefox'): string {
  return join(home, 'extension-install', target);
}

/** reg.exe helper — HKCU only, no elevation needed. */
function reg(args: string[]): { status: number; stdout: string } {
  const r = spawnSync('reg', args, { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  return { status: r.status ?? 1, stdout: (r.stdout ?? '') + (r.stderr ?? '') };
}

export interface InstallableBrowser {
  name: string;
  command: string;
  kind: 'chromium' | 'firefox';
}

/** Discovered browsers ON THIS MACHINE that install.ts can persist into. */
export function findInstallableBrowsers(candidates: Array<{ name: string; command: string }>): InstallableBrowser[] {
  return candidates
    .filter((b) => existsSync(b.command))
    .map((b) => ({ ...b, kind: b.name === 'firefox' ? 'firefox' as const : 'chromium' as const }))
    // one entry per browser family (dedupe by name — desktop .lnk shadows)
    .filter((b, i, all) => all.findIndex((x) => x.name === b.name) === i);
}

export interface InstallOutcome {
  browser: string;
  ok: boolean;
  detail: string;
}

/** Write one Chromium-family registry entry pointing at the payload dir. */
function installChromiumRegistry(name: string, payloadDir: string): InstallOutcome {
  const hive = CHROMIUM_REG_HIVES[name];
  if (!hive) return { browser: name, ok: false, detail: '未知的注册表位置(需手动开发者模式装载)' };
  const key = `HKCU\\${hive}\\${EXTENSION_ID}`;
  const add = reg(['add', key, '/v', 'path', '/t', 'REG_SZ', '/d', payloadDir, '/f']);
  if (add.status !== 0) return { browser: name, ok: false, detail: `reg add 失败: ${add.stdout.slice(0, 120)}` };
  const ver = reg(['add', key, '/v', 'version', '/t', 'REG_SZ', '/d', EXTENSION_VERSION, '/f']);
  if (ver.status !== 0) return { browser: name, ok: false, detail: `reg add version 失败: ${ver.stdout.slice(0, 120)}` };
  return { browser: name, ok: true, detail: `注册表 ${key} → ${payloadDir}(浏览器重启后生效)` };
}

/** Firefox enterprise policy: ExtensionSettings force_installed (file:// XPI). */
function installFirefoxPolicy(xpiPath: string): InstallOutcome {
  const policyKey = 'HKCU\\Software\\Policies\\Mozilla\\Firefox';
  const settings: Record<string, unknown> = {};
  // merge with any existing ExtensionSettings (never clobber other installs)
  const query = reg(['query', policyKey, '/v', 'ExtensionSettings']);
  if (query.status === 0) {
    const m = /ExtensionSettings\s+REG_SZ\s+(.+)/.exec(query.stdout);
    if (m) {
      try { Object.assign(settings, JSON.parse(m[1].trim())); } catch { /* corrupt existing value — start fresh */ }
    }
  }
  settings['bridge@hmharness.dev'] = {
    installation_mode: 'force_installed',
    install_url: `file:///${xpiPath.replace(/\\/g, '/')}`,
  };
  const set = reg(['add', policyKey, '/v', 'ExtensionSettings', '/t', 'REG_SZ', '/d', JSON.stringify(settings), '/f']);
  if (set.status !== 0) return { browser: 'firefox', ok: false, detail: `reg add 策略失败: ${set.stdout.slice(0, 120)}` };
  return { browser: 'firefox', ok: true, detail: `策略 force_installed → ${xpiPath}(浏览器重启后生效)` };
}

export interface InstallResult {
  builds: { chromium?: string; firefox?: string };
  outcomes: InstallOutcome[];
}

/** Build payloads into the STABLE dir and register them everywhere found. */
export async function installExtension(opts: {
  home: string;
  browsers: Array<{ name: string; command: string }>;
  port?: number;
}): Promise<InstallResult> {
  const chromium = findInstallableBrowsers(opts.browsers).filter((b) => b.kind === 'chromium');
  const firefox = findInstallableBrowsers(opts.browsers).filter((b) => b.kind === 'firefox');
  const outcomes: InstallOutcome[] = [];
  const builds: InstallResult['builds'] = {};

  if (chromium.length > 0) {
    const [built] = await buildExtension({ target: 'chromium', outDir: stableInstallDir(opts.home, 'chromium'), port: opts.port });
    builds.chromium = built.dir;
    for (const b of chromium) outcomes.push(installChromiumRegistry(b.name, built.dir));
    // the channel that actually persists on 2026 Chromium (registry
    // entries are inert on branded builds): launcher shortcuts carrying
    // --load-extension. Chrome is excluded inside (flag is dead there).
    for (const o of installShortcuts({ home: opts.home, payloadDir: built.dir, browsers: opts.browsers })) outcomes.push(o);
  }
  if (firefox.length > 0) {
    const [built] = await buildExtension({ target: 'firefox', outDir: stableInstallDir(opts.home, 'firefox'), port: opts.port });
    builds.firefox = built.dir;
    // Compress-Archive ONLY accepts .zip destinations — pack to .zip then
    // rename to .xpi (byte-identical container, Firefox's expected suffix)
    const zip = join(built.dir, '..', 'hmharness-bridge.zip');
    const xpi = join(built.dir, '..', 'hmharness-bridge.xpi');
    const pack = spawnSync('powershell', ['-NoProfile', '-Command',
      `Compress-Archive -Path '${built.dir.replace(/'/g, "''")}*' -DestinationPath '${zip.replace(/'/g, "''")}' -Force`],
      { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    if (pack.status !== 0 || !existsSync(zip)) {
      outcomes.push({ browser: 'firefox', ok: false, detail: `打包失败(PowerShell Compress-Archive): ${String(pack.stderr ?? '').slice(0, 100)}` });
    } else {
      const { renameSync } = await import('node:fs');
      try { renameSync(zip, xpi); } catch { /* rename fails only if xpi exists+locked — the policy can point at the .zip just as well */ }
      const target = existsSync(xpi) ? xpi : zip;
      outcomes.push(installFirefoxPolicy(target));
    }
  }
  return { builds, outcomes };
}

/** Remove every registry trace this package wrote (both channels). */
export async function uninstallExtension(opts: { home: string; browsers: Array<{ name: string; command: string }> }): Promise<InstallOutcome[]> {
  const outcomes: InstallOutcome[] = [];
  for (const name of new Set(findInstallableBrowsers(opts.browsers).filter((b) => b.kind === 'chromium').map((b) => b.name))) {
    const hive = CHROMIUM_REG_HIVES[name];
    if (!hive) continue;
    const r = reg(['delete', `HKCU\\${hive}\\${EXTENSION_ID}`, '/f']);
    outcomes.push({ browser: name, ok: r.status === 0, detail: r.status === 0 ? '已移除注册表项' : '本就未安装' });
  }
  // firefox policy: strip ONLY our entry, keep others intact
  const policyKey = 'HKCU\\Software\\Policies\\Mozilla\\Firefox';
  const query = reg(['query', policyKey, '/v', 'ExtensionSettings']);
  if (query.status === 0) {
    const m = /ExtensionSettings\s+REG_SZ\s+(.+)/.exec(query.stdout);
    if (m) {
      try {
        const settings = JSON.parse(m[1].trim()) as Record<string, unknown>;
        if ('bridge@hmharness.dev' in settings) {
          delete settings['bridge@hmharness.dev'];
          if (Object.keys(settings).length === 0) {
            reg(['delete', policyKey, '/v', 'ExtensionSettings', '/f']);
          } else {
            reg(['add', policyKey, '/v', 'ExtensionSettings', '/t', 'REG_SZ', '/d', JSON.stringify(settings), '/f']);
          }
          outcomes.push({ browser: 'firefox', ok: true, detail: '已从策略移除(保留其它扩展)' });
        } else {
          outcomes.push({ browser: 'firefox', ok: true, detail: '本就未安装' });
        }
      } catch { outcomes.push({ browser: 'firefox', ok: false, detail: '既有策略值损坏,未改动' }); }
    }
  } else {
    outcomes.push({ browser: 'firefox', ok: true, detail: '本就未安装' });
  }
  return outcomes;
}

/** Read-only view: what does each browser's persistent channel say now? */
export function installedEverywhere(browsers: Array<{ name: string; command: string }>): Array<{ browser: string; installed: boolean; detail: string }> {
  return findInstallableBrowsers(browsers).map((b) => {
    if (b.kind === 'firefox') {
      const q = reg(['query', 'HKCU\\Software\\Policies\\Mozilla\\Firefox', '/v', 'ExtensionSettings']);
      const hit = q.status === 0 && /bridge@hmharness\.dev/.test(q.stdout);
      return { browser: b.name, installed: hit, detail: hit ? '策略 force_installed' : '未安装(hmh extension install)' };
    }
    const hive = CHROMIUM_REG_HIVES[b.name];
    if (!hive) return { browser: b.name, installed: false, detail: '无已知注册表通道(手动开发者模式装载)' };
    const q = reg(['query', `HKCU\\${hive}\\${EXTENSION_ID}`]);
    if (q.status !== 0) return { browser: b.name, installed: false, detail: '未安装(hmh extension install)' };
    const m = /path\s+REG_SZ\s+(\S+)/.exec(q.stdout);
    const pathOk = m && existsSync(m[1]);
    return { browser: b.name, installed: Boolean(pathOk), detail: pathOk ? `→ ${m[1]}` : '注册表项存在但载荷目录缺失(重装修复)' };
  });
}

/** Shortcut-based persistent install (round 42, the channel that WORKS):
 *  2026 Chromium reality, empirically pinned down on this machine —
 *  registry external-unpacked entries are ignored (even with developer
 *  mode pre-seeded) and hand-written Preferences records are cleaned.
 *  What DOES survive every restart for Edge/Brave/Opera/Quark/BrowserOS:
 *  the launcher shortcut itself carrying --load-extension. We amend the
 *  existing .lnk files (Desktop + Start Menus + taskbar), and CREATE a
 *  desktop launcher for browsers whose only entry points are un-amendable
 *  (Edge ships as a taskbar pin with no classic shortcut). Matched by
 *  FULL target path — exe names alone would cross-hit branded Chrome's
 *  chrome.exe (its flag is dead; amending its shortcuts would be noise).
 *  Originals are backed up for a clean uninstall. */
export function installShortcuts(opts: { home: string; payloadDir: string; browsers: Array<{ name: string; command: string }> }): InstallOutcome[] {
  const targets = new Map<string, string>(); // full exe path -> browser name
  for (const b of opts.browsers) {
    if (b.name === 'chrome' || b.name === 'firefox') continue; // no working flag channel
    if (existsSync(b.command)) targets.set(b.command.toLowerCase(), b.name);
  }
  if (targets.size === 0) return [];
  const flag = ` --load-extension="${opts.payloadDir}"`;
  const searchDirs = [
    join(process.env.USERPROFILE ?? '', 'Desktop'),
    join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join('C:', 'ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(process.env.APPDATA ?? '', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
  ];
  const backupFile = join(stableInstallDir(opts.home, 'chromium'), '..', 'shortcut-backup.json');
  const backup: Record<string, string> = (() => {
    try { return JSON.parse(readFileSync(backupFile, 'utf8')); } catch { return {}; }
  })();
  const outcomes: InstallOutcome[] = [];
  const amendedBrowsers = new Set<string>();
  for (const dir of searchDirs) {
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.lnk')).map((f) => join(dir, f)); } catch { continue; }
    for (const lnk of files) {
      let target = '';
      try {
        const r = spawnSync('powershell', ['-NoProfile', '-Command',
          `(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}').TargetPath`],
          { encoding: 'utf8', timeout: 10_000, windowsHide: true });
        target = (r.stdout ?? '').trim();
      } catch { continue; }
      const name = targets.get(target.toLowerCase());
      if (!name) continue;
      const ps = [
        `$sh = New-Object -ComObject WScript.Shell`,
        `$s = $sh.CreateShortcut('${lnk.replace(/'/g, "''")}')`,
        `if ($s.Arguments -notlike '*hmharness*') {`,
        `  $s.Arguments = $s.Arguments + '${flag.replace(/'/g, "''")}'`,
        `  $s.Save()`,
        `  Write-Output AMENDED`,
        `} else { Write-Output ALREADY }`,
      ].join('; ');
      const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
      const out = (r.stdout ?? '').trim();
      if (out === 'AMENDED') backup[lnk] = 'amended';
      if (out === 'AMENDED' || out === 'ALREADY') {
        amendedBrowsers.add(name);
        if (!outcomes.some((o) => o.browser === name)) {
          outcomes.push({ browser: name, ok: true, detail: out === 'AMENDED' ? `快捷方式已加 --load-extension(${lnk})` : '快捷方式已带有装载参数' });
        }
      }
    }
  }
  // browsers with NO amendable shortcut get a fresh desktop launcher
  const desktop = join(process.env.USERPROFILE ?? '', 'Desktop');
  for (const [exe, name] of targets) {
    if (amendedBrowsers.has(name)) continue;
    const lnk = join(desktop, `hmharness · ${name}.lnk`);
    const ps = [
      `$sh = New-Object -ComObject WScript.Shell`,
      `$s = $sh.CreateShortcut('${lnk.replace(/'/g, "''")}')`,
      `$s.TargetPath = '${exe.replace(/'/g, "''")}'`,
      `$s.Arguments = '${flag.replace(/'/g, "''").trim()}'`,
      `$s.Description = 'hmharness bridge extension'`,
      `$s.Save()`,
      `Write-Output CREATED`,
    ].join('; ');
    const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    const ok = (r.stdout ?? '').includes('CREATED');
    outcomes.push({ browser: name, ok, detail: ok ? `已创建桌面启动器 ${lnk}(原任务栏/搜索启动不带扩展)` : `创建启动器失败: ${String(r.stderr ?? '').slice(0, 80)}` });
    if (ok) backup[lnk] = 'created';
  }
  try { writeFileSync(backupFile, JSON.stringify(backup, null, 1), 'utf8'); } catch { /* best-effort */ }
  return outcomes;
}

/** Verify the stable build actually carries the pinned key (guard for install). */
export function buildCarriesPinnedKey(buildDir: string): boolean {
  try {
    const m = JSON.parse(readFileSync(join(buildDir, 'manifest.json'), 'utf8')) as { key?: string };
    return typeof m.key === 'string' && m.key.length > 300;
  } catch { return false; }
}
