/**
 * @hmh/domain-harmony - uiregress (visual UI regression, quality trio #2)
 * Minimal honest version of the old line's visual-regression gap, built
 * from parts that already exist and are device-proven:
 *   hdc shell snapshot_display / uitest UIRecord screenshots + see_image
 *   (multi-provider vision) + keyword assertion.
 *
 * A regression case = { name, launch bundle/ability, expect: keywords the
 * vision model MUST see on the device screen }. Run = launch -> screenshot
 * -> vision describe -> keyword assert -> PASS/FAIL with the description
 * attached as evidence. Fuzzy by nature (vision), so:
 *   - every verdict quotes the model's actual description (auditable)
 *   - a case only passes on an exact keyword hit, never "looks fine"
 * Deliberately NOT pixel-diff: pixel diffs break on emulator GPU font
 * rendering; semantic presence of expected UI text/elements is the
 * production-honest signal.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chatVision, type ProviderConfig, type Tool } from '@hmh/kernel';

const execCb = promisify(execFile);

export interface UiRegressionCase {
  name: string;
  bundle: string;
  ability: string;
  /** keywords the vision model must find on screen (any = hit) */
  expect: string[];
  settleMs?: number;
}

export interface UiRegressionResult {
  case: string;
  pass: boolean;
  saw: string | null;
  description: string;
  screenshot: string | null;
}

/** Capture the device screen via hdc; returns the local file path. */
export async function captureDeviceScreen(hdc: string, target: string | undefined, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const pre = target ? ['-t', target] : [];
  // openharmony uitest UIRecord is the stable screenshot route on device
  const remote = '/data/local/tmp/hmh-shot.jpeg';
  await execCb(hdc, [...pre, 'shell', 'snapshot_display', '-f', '/data/local/tmp/hmh-shot.jpeg'], { timeout: 30_000, windowsHide: true }).catch(() => undefined);
  const local = join(outDir, `ui-${Date.now()}.jpeg`);
  await execCb(hdc, [...pre, 'file', 'recv', remote, local], { timeout: 30_000, windowsHide: true });
  // verify the recv produced a non-empty file; retry with uitest if not
  try {
    const st = await readFile(local).then((b) => b.length).catch(() => 0);
    if (st > 1000) return local;
  } catch { /* fall through to uitest */ }
  await execCb(hdc, [...pre, 'shell', 'uitest', 'UIRecord', 'start'].flat(), { timeout: 20_000, windowsHide: true }).catch(() => undefined);
  await rm(local, { force: true }).catch(() => undefined);
  await execCb(hdc, [...pre, 'shell', 'uitest', 'UIRecord', 'lastOutput', remote], { timeout: 20_000, windowsHide: true }).catch(() => undefined);
  await execCb(hdc, [...pre, 'file', 'recv', remote, local], { timeout: 30_000, windowsHide: true });
  return local;
}

/** One regression case through the real device + vision chain. */
export async function runUiRegression(opts: {
  hdc: string;
  target?: string;
  vision: ProviderConfig;
  cases: UiRegressionCase[];
  outDir: string;
}): Promise<UiRegressionResult[]> {
  const results: UiRegressionResult[] = [];
  for (const c of opts.cases) {
    const pre = opts.target ? ['-t', opts.target] : [];
    // launch
    try {
      await execCb(opts.hdc, [...pre, 'shell', 'aa', 'start', '-a', c.ability, '-b', c.bundle], { timeout: 30_000, windowsHide: true });
    } catch (err) {
      results.push({ case: c.name, pass: false, saw: null, description: 'launch failed: ' + String(err).slice(0, 120), screenshot: null });
      continue;
    }
    await new Promise((r) => setTimeout(r, c.settleMs ?? 3500));
    // screenshot
    let shot: string | null = null;
    try {
      shot = await captureDeviceScreen(opts.hdc, opts.target, opts.outDir);
    } catch (err) {
      results.push({ case: c.name, pass: false, saw: null, description: 'screenshot failed: ' + String(err).slice(0, 120), screenshot: null });
      continue;
    }
    // vision describe
    try {
      const b64 = (await readFile(shot)).toString('base64');
      const text = await chatVision(
        opts.vision,
        'Describe this device screen briefly. Then on the last line output exactly: FOUND: <the most prominent UI text you can read>.',
        `data:image/jpeg;base64,${b64}`,
      );
      const described = text.trim();
      const saw = c.expect.find((k) => described.toLowerCase().includes(k.toLowerCase())) ?? null;
      results.push({ case: c.name, pass: Boolean(saw), saw, description: described.slice(0, 400), screenshot: shot });
    } catch (err) {
      results.push({ case: c.name, pass: false, saw: null, description: 'vision failed: ' + String(err).slice(0, 150), screenshot: shot });
    }
  }
  return results;
}

export const harmonyUiRegression: Tool = {
  name: 'harmony_ui_regression',
  description:
    'Visual UI regression on a connected device/emulator: launch the app, screenshot the real screen, describe it with the vision model, and assert expected keywords are visible. Each verdict quotes the model description (auditable, never a blind pass). Cases given inline (bundle/ability/expect keywords). Semantic presence check, not pixel diff - resilient to GPU font rendering differences.',
  parameters: {
    type: 'object',
    properties: {
      bundle: { type: 'string', description: 'bundle to launch' },
      ability: { type: 'string', description: 'ability to launch (default EntryAbility)' },
      expect: { type: 'array', items: { type: 'string' }, description: 'keywords that must be visible on screen (any hit = pass)' },
      target: { type: 'string', description: 'device target id from harmony_devices' },
    },
    required: ['bundle', 'expect'],
  },
  needsApproval: () => true, // launches apps + writes screenshot files
  async execute(args, ctx) {
    const bundle = String(args.bundle ?? '').trim();
    const expect = Array.isArray(args.expect) ? (args.expect as string[]).map(String).filter(Boolean) : [];
    if (!bundle || expect.length === 0) return { output: 'bundle and non-empty expect[] required', isError: true };
    // vision provider from config (kernel routing)
    const { loadConfig, resolveProvider } = await import('@hmh/kernel');
    const cfg = await loadConfig();
    let vision: ProviderConfig;
    try {
      vision = resolveProvider(cfg, 'vision');
      if (!vision.apiKey) throw new Error('no key');
    } catch {
      return { output: 'No vision provider configured (vision block or providers+routing.vision) - harmony_ui_regression needs one.', isError: true };
    }
    // hdc
    const deveco = process.env.HM_DEVECO_HOME ?? 'C:\\DevEco-Studio';
    let hdc = 'hdc';
    try { await execCb(hdc, ['--version'], { timeout: 8000, windowsHide: true }); } catch {
      const cand = join(deveco, 'sdk', 'default', 'openharmony', 'toolchains', 'hdc.exe');
      try { await readFile(cand); hdc = cand; } catch { return { output: 'hdc not found.', isError: true }; }
    }
    const outDir = join(ctx.home, 'tmp', 'uiregress');
    const results = await runUiRegression({
      hdc,
      target: typeof args.target === 'string' ? args.target : undefined,
      vision,
      cases: [{ name: `${bundle}/${String(args.ability ?? 'EntryAbility')}`, bundle, ability: String(args.ability ?? 'EntryAbility'), expect }],
      outDir,
    });
    const r = results[0];
    const lines = [
      `UI regression: ${r.case}`,
      r.saw ? `PASS - saw "${r.saw}" on screen` : `FAIL - none of [${expect.join(', ')}] visible`,
      ...(r.screenshot ? [`screenshot: ${r.screenshot}`] : []),
      `vision said: ${r.description}`,
    ];
    return { output: lines.join('\n'), isError: !r.pass };
  },
};
