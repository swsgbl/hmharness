/**
 * @hmh/domain-harmony - signing (hapsigntool wrapper, device-proven)
 * Signs a built .hap with the local debug identity so it installs on
 * emulator/developer-mode devices. Production (release/AGC) signing stays
 * in DevEco/AppGallery - this wraps the DEBUG flow.
 *
 * FULL DEVICE-PROVEN CHAIN (validated on emulator 2026-09-05, the signed
 * hap installed+launched+logged "EntryAbility onCreate"):
 *  1. the SDK debug profile TEMPLATE (UnsgnedDebugProfileTemplate.json)
 *     ships with a 2021-2023 validity window - EXPIRED. We clone it with
 *     a fresh now+30y window (new uuid) into HMH_HOME/tmp.
 *  2. sign-profile: keyAlias "openharmony application profile debug",
 *     profileCertFile = OpenHarmonyProfileDebug.pem (a 3-cert chain),
 *     keystore OpenHarmony.p12 (pwd 123456) -> a fresh .p7b.
 *  3. sign-app: keyAlias "openharmony application profile debug" (!),
 *     appCertFile = the same 3-cert pem, profileFile = the fresh p7b,
 *     mode localSign -> <name>-signed.hap next to the unsigned one.
 * Gotchas learned the hard way:
 *  - keyAlias for sign-app is the PROFILE DEBUG alias, not "application
 *    release" (its self-signed cert fails the chain check).
 *  - -mode value is localSign (not debug/release).
 *  - hdc install wants backslash-normalized Windows paths.
 * Identity override: explicit profile+p12 args skip the SDK flow.
 */
import { execFile } from 'node:child_process';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { promisify } from 'node:util';
import type { Tool } from '@hmh/kernel';

const execCb = promisify(execFile);

export interface SigningIdentity {
  profile: string;
  p12: string;
  cer: string | null;
  keyAlias: string;
  storePassword: string;
  origin: string;
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

export function hapsignToolPaths(devecoHome: string): { jar: string; p12: string; pem: string; template: string; java: string } {
  const lib = join(devecoHome, 'sdk', 'default', 'openharmony', 'toolchains', 'lib');
  return {
    jar: join(lib, 'hap-sign-tool.jar'),
    p12: join(lib, 'OpenHarmony.p12'),
    pem: join(lib, 'OpenHarmonyProfileDebug.pem'),
    template: join(lib, 'UnsgnedDebugProfileTemplate.json'),
    java: join(devecoHome, 'jbr', 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
  };
}

export async function resolveSigningIdentity(devecoHome: string, explicit: Partial<SigningIdentity> = {}): Promise<SigningIdentity | null> {
  if (explicit.profile && explicit.p12) {
    if ((await exists(explicit.profile)) && (await exists(explicit.p12))) {
      return { profile: explicit.profile, p12: explicit.p12, cer: explicit.cer ?? null, keyAlias: explicit.keyAlias ?? 'openharmony application profile debug', storePassword: explicit.storePassword ?? '123456', origin: 'explicit' };
    }
    return null;
  }
  // DevEco auto-sign materials (user-level) - the profile must be a real
  // .p7b; ~/.ohos/config stores handles not files, so only adopt when the
  // user explicitly passes them. The always-works path is the SDK flow.
  const p = hapsignToolPaths(devecoHome);
  if ((await exists(p.p12)) && (await exists(p.pem))) {
    return { profile: '(generated)', p12: p.p12, cer: p.pem, keyAlias: 'openharmony application profile debug', storePassword: '123456', origin: 'sdk debug identity' };
  }
  return null;
}

/** Clone the SDK debug profile template with a FRESH validity window
 *  (the shipped one is 2021-2023 = expired) and sign it into a p7b. */
export async function ensureDebugProfile(devecoHome: string, tmpDir: string, log?: (l: string) => void): Promise<string> {
  const p = hapsignToolPaths(devecoHome);
  const outP7b = join(tmpDir, 'ohos-debug-fresh.p7b');
  if (await exists(outP7b)) return outP7b; // fresh enough (regenerated per HMH_HOME tmp lifecycle)
  const { readFile } = await import('node:fs/promises');
  const tpl = JSON.parse(await readFile(p.template, 'utf8')) as { validity?: { 'not-before': number; 'not-after': number }; uuid?: string };
  const now = Math.floor(Date.now() / 1000);
  tpl.validity = { 'not-before': now - 86400, 'not-after': now + 30 * 365 * 86400 };
  tpl.uuid = 'hmh-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2, 10);
  const tplPath = join(tmpDir, 'debug-profile.json');
  await writeFile(tplPath, JSON.stringify(tpl, null, 2), 'utf8');
  await execCb(p.java, [
    '-jar', p.jar, 'sign-profile',
    '-mode', 'localSign',
    '-keyAlias', 'openharmony application profile debug',
    '-keyPwd', '123456', '-keystoreFile', p.p12, '-keystorePwd', '123456',
    '-profileCertFile', p.pem,
    '-inFile', tplPath, '-signAlg', 'SHA256withECDSA',
    '-outFile', outP7b,
  ], { timeout: 60_000, windowsHide: true });
  log?.(`debug profile generated: ${outP7b}`);
  return outP7b;
}

export interface SignResult {
  signed: string;
}

/** Sign one unsigned .hap (SDK debug identity path). */
export async function signHap(hap: string, id: SigningIdentity, devecoHome: string, tmpDir: string, log?: (l: string) => void): Promise<SignResult> {
  const p = hapsignToolPaths(devecoHome);
  const base = hap.replace(/-unsigned(\.hap)?$/i, '');
  const out = (base.endsWith('.hap') ? base.replace(/\.hap$/i, '') : base) + '-signed.hap';
  const profile = id.profile === '(generated)' ? await ensureDebugProfile(devecoHome, tmpDir, log) : id.profile;
  const cmd = [
    '-jar', p.jar, 'sign-app',
    '-mode', 'localSign',
    '-keyAlias', id.keyAlias,
    '-keyPwd', id.storePassword, '-keystoreFile', id.p12, '-keystorePwd', id.storePassword,
    '-appCertFile', id.cer ?? p.pem,
    '-profileFile', profile,
    '-inFile', hap, '-signAlg', 'SHA256withECDSA',
    '-outFile', out,
  ];
  log?.(`java -jar hap-sign-tool.jar sign-app (profile: ${profile})`);
  await execCb(p.java, cmd, { timeout: 120_000, windowsHide: true });
  return { signed: out };
}

export const harmonySign: Tool = {
  name: 'harmony_sign',
  description:
    'Sign a built .hap with the local debug identity (SDK OpenHarmony identity by default; explicit profile+p12 override) so it installs on emulator/developer-mode devices. Auto-generates a fresh debug profile (the SDK template 2021 validity is expired). Output lands beside the unsigned hap (-signed suffix). Release/AGC signing stays in DevEco.',
  parameters: {
    type: 'object',
    properties: {
      hap: { type: 'string', description: 'unsigned .hap path (default: newest under the project build output)' },
      profile: { type: 'string', description: 'explicit provisioning profile (.p7b) path' },
      p12: { type: 'string', description: 'explicit signing keystore path' },
      cer: { type: 'string', description: 'explicit app cert chain path' },
      key_alias: { type: 'string', description: 'key alias (default: the SDK debug alias)' },
      store_password: { type: 'string', description: 'keystore password (default: 123456 debug)' },
    },
    required: [],
  },
  needsApproval: () => true,
  async execute(args, ctx) {
    const deveco = process.env.HM_DEVECO_HOME ?? 'C:\\DevEco-Studio';
    const p = hapsignToolPaths(deveco);
    if (!(await exists(p.jar))) return { output: `hap-sign-tool.jar not found at ${p.jar}. Set HM_DEVECO_HOME.`, isError: true };
    if (!(await exists(p.java))) return { output: `DevEco bundled java not found at ${p.java}. Set HM_DEVECO_HOME.`, isError: true };
    const id = await resolveSigningIdentity(deveco, {
      profile: typeof args.profile === 'string' ? args.profile : undefined,
      p12: typeof args.p12 === 'string' ? args.p12 : undefined,
      cer: typeof args.cer === 'string' ? args.cer : undefined,
      keyAlias: typeof args.key_alias === 'string' ? args.key_alias : undefined,
      storePassword: typeof args.store_password === 'string' ? args.store_password : undefined,
    });
    if (!id) return { output: 'No signing identity: SDK lib files missing (OpenHarmony.p12 / OpenHarmonyProfileDebug.pem), or pass profile+p12 explicitly.', isError: true };
    // resolve the hap
    let hap = typeof args.hap === 'string' && args.hap ? resolve(ctx.cwd, args.hap) : '';
    if (!hap) {
      let dir = ctx.cwd;
      for (;;) {
        if (await exists(join(dir, 'build-profile.json5'))) break;
        const parent = resolve(dir, '..');
        if (parent === dir) return { output: 'No .hap given and no project found around cwd.', isError: true };
        dir = parent;
      }
      const { stat } = await import('node:fs/promises');
      let best = ''; let bestMtime = 0;
      const stack = [dir];
      while (stack.length) {
        const d = stack.pop()!;
        let entries;
        try { entries = await readdir(d, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          const pp = join(d, e.name);
          if (e.isDirectory()) { if (!['node_modules', 'oh_modules', '.hvigor', '.preview'].includes(e.name)) stack.push(pp); }
          else if (e.name.endsWith('.hap') && !e.name.includes('-signed')) {
            const m = (await stat(pp)).mtimeMs;
            if (m > bestMtime) { bestMtime = m; best = pp; }
          }
        }
      }
      hap = best;
      if (!hap) return { output: 'No unsigned .hap found. Build first with harmony_build.', isError: true };
    }
    if (!(await exists(hap))) return { output: `No such file: ${hap}`, isError: true };
    const tmpDir = join(ctx.home, 'tmp');
    await mkdir(tmpDir, { recursive: true });
    try {
      const r = await signHap(hap, id, deveco, tmpDir);
      const ok = await exists(r.signed);
      return {
        output: [
          `identity: ${id.origin}`,
          `signed: ${r.signed}`,
          `source: ${hap}`,
          ok ? 'OK - install the signed hap (harmony_install / harmony_device_test).' : 'WARNING: output missing after sign',
        ].join('\n'),
        isError: !ok,
      };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return { output: ['sign failed:', e.stdout || '', e.stderr || e.message || ''].filter(Boolean).join('\n').slice(0, 2000), isError: true };
    }
  },
};
