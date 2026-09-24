/**
 * @hmharness/domain-harmony - resolve (single implementation)
 * ONE place for DevEco home discovery. The 2026-09-11 audit lesson (security
 * gates must have a single shared implementation) applies to path resolution
 * too: seven callers each carried their own `HM_DEVECO_HOME ?? 'C:\\DevEco-Studio'`,
 * so the standard "Program Files" install kept breaking different tools one
 * patch at a time (hdc 0.11.0, emulator 0.13.1, then five more found by the
 * day-29 SELFFEED sweep). Every tool imports from here now.
 */
import { accessSync } from 'node:fs';
import { join } from 'node:path';

/** Standard DevEco install locations, probed in order. */
export const DEVECO_CANDIDATES = [
  'C:\\Program Files\\Huawei\\DevEco Studio',
  'D:\\Program Files\\Huawei\\DevEco Studio',
  'C:\\DevEco-Studio',
];

/** Sibling of the resolved home that must exist for a probe to count. */
const hdcRel = ['sdk', 'default', 'openharmony', 'toolchains', 'hdc.exe'];

/** Resolve the DevEco Studio home: explicit env wins, then probe standard
 *  installs by a known child (hdc.exe), finally fall back to the legacy bare
 *  path (callers surface a clear not-found error from there). */
export function resolveDevecoHome(): string {
  if (process.env.HM_DEVECO_HOME) return process.env.HM_DEVECO_HOME;
  for (const home of DEVECO_CANDIDATES) {
    try {
      accessSync(join(home, ...hdcRel));
      return home;
    } catch { /* next */ }
  }
  return DEVECO_CANDIDATES[DEVECO_CANDIDATES.length - 1];
}

/** Resolve the Emulator.exe path with the same contract (its probe child is
 *  Emulator.exe itself, so a bare home without the emulator component still
 *  resolves to a path whose absence callers report clearly). */
export function resolveEmulatorExe(): string {
  if (process.env.HM_DEVECO_HOME) return join(process.env.HM_DEVECO_HOME, 'tools', 'emulator', 'Emulator.exe');
  for (const home of DEVECO_CANDIDATES) {
    const cand = join(home, 'tools', 'emulator', 'Emulator.exe');
    try {
      accessSync(cand);
      return cand;
    } catch { /* next */ }
  }
  return join(DEVECO_CANDIDATES[DEVECO_CANDIDATES.length - 1], 'tools', 'emulator', 'Emulator.exe');
}

/** Resolve hdc: PATH first, then the SDK layout under the resolved home. */
export async function resolveHdc(run: (args: string[]) => Promise<{ ok: boolean }>): Promise<string> {
  const p = await run(['--version']);
  if (p.ok) return 'hdc';
  const candidate = join(resolveDevecoHome(), ...hdcRel);
  try {
    accessSync(candidate);
    return candidate;
  } catch {
    return '';
  }
}
