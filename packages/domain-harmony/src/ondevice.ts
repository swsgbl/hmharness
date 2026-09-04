/**
 * @hmh/domain-harmony - ondevicetest (minimal honest version)
 * The ROADMAP gap "onDeviceTest 设备测试": a scripted assertion loop over
 * the REAL device instead of a hypothetical unit-test framework. What we
 * can actually verify on-device today, deterministically:
 *   1. the hap installs
 *   2. the ability launches
 *   3. the app's own lifecycle log marker appears in hilog within N seconds
 *   4. (cleanup) uninstalls
 * That is exactly the loop our e2e script runs by hand - productized as a
 * tool with a pass/fail verdict per step. Richer device-side test runners
 * (aa test / ArkTSTDD) can slot in behind the same verdict shape later.
 */
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Tool } from '@hmh/kernel';

const execCb = promisify(execFile);

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

export interface DeviceTestStep {
  step: string;
  pass: boolean;
  detail: string;
}

export interface DeviceTestOptions {
  hdc: string;
  target?: string;
  hap: string;
  bundle: string;
  ability: string;
  /** log marker the app must print on startup (EntryAbility onCreate) */
  expectLog: string;
  waitMs?: number;
  /** Injectable command runner (tests stub this; production uses execFile). */
  runImpl?: (args: string[], timeout: number) => Promise<{ ok: boolean; out: string }>;
}

export async function runDeviceTest(o: DeviceTestOptions): Promise<DeviceTestStep[]> {
  const pre = o.target ? ['-t', o.target] : [];
  const run = o.runImpl ?? (async (args: string[], timeout: number) => {
    try {
      const { stdout, stderr } = await execCb(o.hdc, [...pre, ...args], { timeout, windowsHide: true });
      return { ok: true, out: ((stdout || '') + (stderr ? '\n' + stderr : '')).trim() };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return { ok: false, out: [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').slice(0, 600) };
    }
  });
  const steps: DeviceTestStep[] = [];
  // 1. install
  let r = await run(['install', '-r', o.hap], 120_000);
  if (!r.ok || /fail/i.test(r.out)) r = await run(['app', 'install', '-r', o.hap], 120_000);
  steps.push({ step: 'install', pass: r.ok && /success/i.test(r.out), detail: r.out.slice(0, 200) });
  if (!steps[0].pass) return steps;
  // 2. launch
  r = await run(['shell', 'aa', 'start', '-a', o.ability, '-b', o.bundle], 30_000);
  steps.push({ step: 'launch', pass: r.ok && /successfully/i.test(r.out), detail: r.out.slice(0, 200) });
  // 3. lifecycle marker in hilog (poll briefly - logs flush asynchronously)
  let sawMarker = false;
  let tail = '';
  const wait = o.waitMs ?? 6000;
  const t0 = Date.now();
  while (!sawMarker && Date.now() - t0 < wait) {
    await new Promise((res) => setTimeout(res, 1000));
    const g = await run(['shell', 'hilog', '-x'], 30_000);
    tail = g.out;
    sawMarker = tail.includes(o.expectLog);
  }
  steps.push({ step: `log-marker "${o.expectLog}"`, pass: sawMarker, detail: sawMarker ? `found in hilog within ${Date.now() - t0}ms` : `NOT found in ${(wait / 1000).toFixed(0)}s of hilog tail` });
  // 4. cleanup uninstall
  r = await run(['uninstall', o.bundle], 60_000);
  if (!r.ok || /unknown command/i.test(r.out)) r = await run(['app', 'uninstall', o.bundle], 60_000);
  steps.push({ step: 'uninstall(cleanup)', pass: r.ok && /success/i.test(r.out), detail: r.out.slice(0, 120) });
  return steps;
}

export const harmonyDeviceTest: Tool = {
  name: 'harmony_device_test',
  description:
    'On-device smoke test of a .hap against a connected device/emulator: install -> launch ability -> assert the app lifecycle marker appears in hilog (polls up to 6s) -> cleanup uninstall. Returns a per-step pass/fail verdict table. This is the honest minimal device test: real install, real launch, real log evidence.',
  parameters: {
    type: 'object',
    properties: {
      hap: { type: 'string', description: 'signed .hap path (default: newest -signed under the project)' },
      bundle: { type: 'string', description: 'bundle name (default: read from AppScope/app.json5)' },
      ability: { type: 'string', description: 'ability to launch (default: EntryAbility)' },
      expect_log: { type: 'string', description: 'log marker to assert (default: "EntryAbility onCreate")' },
      target: { type: 'string', description: 'device target id from harmony_devices' },
    },
    required: [],
  },
  needsApproval: () => true, // installs+launches+uninstalls on the device
  async execute(args, ctx) {
    // resolve hdc
    const deveco = process.env.HM_DEVECO_HOME ?? 'C:\\DevEco-Studio';
    let hdc = 'hdc';
    try { await execCb(hdc, ['--version'], { timeout: 8000, windowsHide: true }); } catch {
      const cand = join(deveco, 'sdk', 'default', 'openharmony', 'toolchains', 'hdc.exe');
      if (await exists(cand)) hdc = cand;
      else return { output: 'hdc not found.', isError: true };
    }
    // project root walk
    let root = ctx.cwd;
    for (;;) {
      if (await exists(join(root, 'build-profile.json5'))) break;
      const parent = resolve(root, '..');
      if (parent === root) break;
      root = parent;
    }
    // hap: explicit or newest -signed
    let hap = typeof args.hap === 'string' && args.hap ? resolve(ctx.cwd, args.hap) : '';
    if (!hap) {
      const { readdir, stat } = await import('node:fs/promises');
      let best = ''; let bestMtime = 0;
      const stack = [root];
      while (stack.length) {
        const d = stack.pop()!;
        let entries;
        try { entries = await readdir(d, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          const p = join(d, e.name);
          if (e.isDirectory()) { if (!['node_modules', 'oh_modules', '.hvigor', '.preview', 'src'].includes(e.name)) stack.push(p); }
          else if (e.name.endsWith('-signed.hap')) {
            const m = (await stat(p)).mtimeMs;
            if (m > bestMtime) { bestMtime = m; best = p; }
          }
        }
      }
      hap = best;
      if (!hap) return { output: 'No signed .hap found. harmony_build then harmony_sign first (device tests need a signed hap).', isError: true };
    }
    if (!(await exists(hap))) return { output: `No such file: ${hap}`, isError: true };
    // bundle from app.json5 (via the schema module's lenient parser)
    let bundle = typeof args.bundle === 'string' && args.bundle ? args.bundle : '';
    if (!bundle) {
      const { parseJson5 } = await import('./schema.ts');
      try {
        const app = parseJson5(await (await import('node:fs/promises')).readFile(join(root, 'AppScope', 'app.json5'), 'utf8')) as { app?: { bundleName?: string } };
        bundle = app.app?.bundleName ?? '';
      } catch { /* schema check reports */ }
    }
    if (!bundle) return { output: 'Could not determine bundle name - pass `bundle` explicitly.', isError: true };
    const steps = await runDeviceTest({
      hdc,
      target: typeof args.target === 'string' ? args.target : undefined,
      hap,
      bundle,
      ability: typeof args.ability === 'string' && args.ability ? args.ability : 'EntryAbility',
      expectLog: typeof args.expect_log === 'string' && args.expect_log ? args.expect_log : 'EntryAbility onCreate',
    });
    const allPass = steps.every((s) => s.pass);
    const lines = [
      `device test: ${hap} (bundle ${bundle})`,
      ...steps.map((s) => `  ${s.pass ? 'PASS' : 'FAIL'} ${s.step}${s.detail && !s.pass ? ` - ${s.detail}` : ''}`),
      allPass ? 'ALL STEPS PASS - the app really installed, launched and logged on device.' : 'FAILED steps above - each names what broke.',
    ];
    return { output: lines.join('\n'), isError: !allPass };
  },
};
