/**
 * @hmharness/extension - build unpacked extension directories
 *
 * `hmh extension build --target=firefox` (or =all) writes a LOADABLE,
 * per-browser unpacked directory: the zero-build payload (background.js,
 * popup/sidepanel HTML, ui.js, style.css) copied verbatim + a manifest
 * generated for the target from the adapters matrix, then machine-
 * validated (validateManifest) before the directory is declared done.
 * No bundler — same discipline as the web package's embedded SPA.
 */
import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { EXTENSION_TARGETS, manifestFor, TARGET_SPECS, validateManifest, type ExtensionTarget } from './adapters.ts';

export const PAYLOAD_FILES = ['background.js', 'popup.html', 'sidepanel.html', 'ui.js', 'style.css'] as const;

/** The zero-build payload directory inside this package (works from src/
 *  under tsx and from dist/ after tsc — both sit one level under the
 *  package root, next to extension/). */
export function payloadDir(): string {
  return resolve(fileURLToPath(new URL('../extension/', import.meta.url)));
}

export interface BuildResult {
  target: ExtensionTarget;
  dir: string;
  loadHint: string;
  notes: string[];
}

export interface BuildOptions {
  target?: ExtensionTarget | 'all';
  /** output root; each target lands in <outDir>/<target> */
  outDir?: string;
  port?: number;
  version?: string;
}

export async function buildExtension(opts: BuildOptions = {}): Promise<BuildResult[]> {
  const port = opts.port ?? (Number(process.env.HMH_EXTENSION_PORT ?? 0) || 7789);
  const targets = !opts.target || opts.target === 'all' ? EXTENSION_TARGETS : [opts.target];
  const outRoot = resolve(opts.outDir ?? 'dist/extension-build');
  const src = payloadDir();
  const results: BuildResult[] = [];
  for (const target of targets) {
    const spec = TARGET_SPECS[target];
    const dir = join(outRoot, target);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    // 1. payload copied verbatim (assert each file exists — a missing asset
    //    must fail the build, not surface as a broken install later)
    for (const f of PAYLOAD_FILES) {
      const from = join(src, f);
      const s = await stat(from).catch(() => null);
      if (!s?.isFile()) throw new Error(`extension payload missing: ${from}`);
      await cp(from, join(dir, f));
    }
    // 2. per-target manifest, validated before it can ship
    const manifest = manifestFor(target, { port, version: opts.version });
    const problems = validateManifest(target, manifest);
    if (problems.length > 0) {
      throw new Error(`manifest for ${target} failed validation: ${problems.join('; ')}`);
    }
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    results.push({ target, dir, loadHint: spec.loadHint, notes: spec.notes });
  }
  return results;
}
