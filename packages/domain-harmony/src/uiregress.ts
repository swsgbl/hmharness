/**
 * @hmharness/domain-harmony - uiregress (visual UI regression, quality trio #2)
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
import { chatVision, foundNothing, isVisionRefusal, type ProviderConfig, type Tool } from '@hmharness/kernel';

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
  /** true when NO provider actually looked at the image (all blind/failed).
   *  The verdict is then about the vision chain, NOT about the app: never
   *  render it as a product FAIL - a tool that reports FAIL when its own
   *  eyes are shut is worse than no tool. */
  visionUnavailable?: boolean;
  /** per-provider errors collected while walking the vision chain */
  visionErrors?: string[];
}

/** Injectable vision call (tests substitute it; production uses chatVision). */
export type VisionCall = (provider: ProviderConfig, prompt: string, imageDataUrl: string) => Promise<string>;

/**
 * Walk the vision chain until a provider truly LOOKS at the image. A reply
 * that is a refusal ("I can't view the image" - what a text-only provider
 * returns with HTTP 200) is treated as a provider failure and the next
 * candidate is tried. Returns the first real description, or the collected
 * errors when every provider was blind/dead.
 */
export async function describeWithChain(
  chain: ProviderConfig[],
  prompt: string,
  imageDataUrl: string,
  call: VisionCall = chatVision,
): Promise<{ described: string | null; errors: string[] }> {
  const errors: string[] = [];
  for (const provider of chain) {
    try {
      const text = await call(provider, prompt, imageDataUrl);
      if (isVisionRefusal(text)) {
        errors.push(`${provider.model}: answered without seeing the image ("${text.trim().slice(0, 80)}")`);
        continue;
      }
      return { described: text, errors };
    } catch (err) {
      errors.push(`${provider.model}: ${String(err).slice(0, 120)}`);
    }
  }
  return { described: null, errors };
}

/** Keyword assertion on a genuine description (any hit wins). */
export function assertKeywords(described: string, expect: string[]): string | null {
  return expect.find((k) => described.toLowerCase().includes(k.toLowerCase())) ?? null;
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
  /** one provider, or the ordered chain (vision + visionFallbacks) */
  vision: ProviderConfig | ProviderConfig[];
  cases: UiRegressionCase[];
  outDir: string;
  /** test seam: substitute the multimodal call */
  visionCall?: VisionCall;
}): Promise<UiRegressionResult[]> {
  const chain = Array.isArray(opts.vision) ? opts.vision : [opts.vision];
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
    // vision describe (through the chain; refusals do not count as seeing)
    const b64 = (await readFile(shot)).toString('base64');
    const { described, errors } = await describeWithChain(
      chain,
      'Describe this device screen briefly. Then on the last line output exactly: FOUND: <the most prominent UI text you can read>.',
      `data:image/jpeg;base64,${b64}`,
      opts.visionCall,
    );
    if (described === null) {
      // EVERY provider failed to look: this says nothing about the app.
      results.push({
        case: c.name,
        pass: false,
        saw: null,
        visionUnavailable: true,
        visionErrors: errors,
        description: `VISION PROVIDER FAILURE (no UI verdict): none of the ${chain.length} configured vision provider(s) could see the image - ${errors.join('; ')}`,
        screenshot: shot,
      });
      continue;
    }
    const text = described.trim();
    const saw = assertKeywords(text, c.expect);
    if (!saw && foundNothing(text)) {
      // the model itself says it read no text: no evidence either way
      results.push({
        case: c.name,
        pass: false,
        saw: null,
        visionUnavailable: true,
        visionErrors: [...errors, `${chain[0].model}: reported no readable text on screen ("${text.slice(0, 120)}")`],
        description: `NO VERDICT - the vision model reported no readable text on screen (blank screen, or a provider that cannot see): ${text.slice(0, 240)}`,
        screenshot: shot,
      });
      continue;
    }
    results.push({ case: c.name, pass: Boolean(saw), saw, description: text.slice(0, 400), screenshot: shot, visionErrors: errors });
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
    // vision provider from config (kernel routing): the full chain, so a
    // blind or dead provider is retried rather than graded as a UI verdict
    const { loadConfig, visionProviderChain } = await import('@hmharness/kernel');
    const cfg = await loadConfig();
    let vision: ProviderConfig[];
    try {
      vision = visionProviderChain(cfg);
      if (vision.length === 0 || !vision[0].apiKey) throw new Error('no key');
    } catch {
      return { output: 'No vision provider configured (vision block or providers+routing.vision) - harmony_ui_regression needs one.', isError: true };
    }
    const chainNames = vision.map((p) => `${p.model}${p.supportsVision === false ? ' (marked text-only!)' : ''}`);
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
    if (r.visionUnavailable) {
      // The machine could not look at the screen. Report that loudly and do
      // NOT dress it up as a product verdict.
      return {
        output: [
          `UI regression: ${r.case}`,
          `NO VERDICT - vision provider failure, not a UI result`,
          `vision chain tried (${chainNames.join(' -> ')}):`,
          ...(r.visionErrors ?? []).map((e) => `  - ${e}`),
          ...(r.screenshot ? [`screenshot: ${r.screenshot}`] : []),
          'Fix: point routing.vision at a model that accepts images, or mark the text-only one with "supportsVision": false so it is skipped.',
          'Ground truth without vision: hdc shell uitest dumpLayout -p /data/local/tmp/layout.json (the view tree carries every node text).',
        ].join('\n'),
        isError: true,
      };
    }
    const lines = [
      `UI regression: ${r.case}`,
      r.saw ? `PASS - saw "${r.saw}" on screen` : `FAIL - none of [${expect.join(', ')}] visible`,
      ...(r.screenshot ? [`screenshot: ${r.screenshot}`] : []),
      `vision said: ${r.description}`,
    ];
    if (r.visionErrors?.length) {
      lines.push(`degraded chain (earlier provider(s) did not see the image): ${r.visionErrors.join('; ')}`);
    }
    return { output: lines.join('\n'), isError: !r.pass };
  },
};
