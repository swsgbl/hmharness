/**
 * @hmh/domain-harmony - apimatrix (API-level capability matrix)
 * SDK version strings come in TWO shapes and toolchain behavior differs
 * across them:
 *   legacy:  "6.1.1(24)"            - <version>(<api-level>) up to API 25
 *   semver:  "26.0.0" and later     - pure SemVer; the API level IS the
 *                                     major (26.0.0 == API 26)
 *
 * Everything that branches on "which SDK / API level is this" (scaffold
 * defaults, capability guards, compat warnings) goes through this module
 * so the 26.0.0 switch happens in exactly one place.
 */

export interface SdkVersion {
  raw: string;
  apiLevel: number;
  shape: 'legacy' | 'semver';
  /** comparable numeric tuple for range math */
  tuple: [number, number, number];
}

/** Parse "6.1.1(24)" / "5.0.5(17)" / "26.0.0" / "26.1.2". Throws on junk. */
export function parseSdkVersion(raw: string): SdkVersion {
  const s = raw.trim();
  const legacy = /^(\d+)\.(\d+)\.(\d+)\((\d+)\)$/.exec(s);
  if (legacy) {
    const [, a, b, c, lvl] = legacy;
    return { raw: s, apiLevel: Number(lvl), shape: 'legacy', tuple: [Number(a), Number(b), Number(c)] };
  }
  const semver = /^(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (semver) {
    const [, a, b, c] = semver;
    const tuple: [number, number, number] = [Number(a), Number(b), Number(c)];
    // from 26 on, the major IS the API level (HarmonyOS NEXT renumbering)
    return { raw: s, apiLevel: tuple[0], shape: tuple[0] >= 26 ? 'semver' : 'legacy', tuple };
  }
  throw new Error(`unrecognized SDK version "${raw}" - expected "6.1.1(24)" or "26.0.0" style`);
}

/** Compare two SDK versions (tuple math; throws on unparseable input). */
export function compareSdk(a: string, b: string): number {
  const ta = parseSdkVersion(a).tuple;
  const tb = parseSdkVersion(b).tuple;
  for (let i = 0; i < 3; i++) {
    if (ta[i] !== tb[i]) return ta[i] < tb[i] ? -1 : 1;
  }
  return 0;
}

export interface CapabilityRule {
  id: string;
  /** minimum SDK version (inclusive) */
  since: string;
  /** maximum SDK version (exclusive); omit = open-ended */
  until?: string;
  note: string;
}

/**
 * The capability matrix. Extend entries as toolchain knowledge lands; the
 * radar/knowledge pipeline can propose additions through the normal skill
 * gate. Keep notes one actionable line each.
 */
export const CAPABILITY_MATRIX: CapabilityRule[] = [
  { id: 'stage-model', since: '5.0.0(12)', note: 'stage model is the only supported model' },
  { id: 'har-module', since: '5.0.0(12)', note: 'har shared libraries' },
  { id: 'shared-module', since: '5.0.5(17)', note: 'shared (static) module type' },
  { id: '2in1-devicetype', since: '5.0.5(17)', note: '"2in1" deviceType token' },
  { id: 'semver-numbering', since: '26.0.0', note: 'version strings drop the (api) suffix; major == API level' },
];

/** Which matrix rules apply to a given SDK version (sorted by since). */
export function capabilitiesFor(sdk: string): Array<CapabilityRule & { available: boolean }> {
  const out = CAPABILITY_MATRIX.map((r) => ({
    ...r,
    available: compareSdk(sdk, r.since) >= 0 && (r.until ? compareSdk(sdk, r.until) < 0 : true),
  }));
  return out.sort((a, b) => (a.available === b.available ? compareSdk(a.since, b.since) : a.available ? -1 : 1));
}

/** Format a version for build-profile compatibleSdkVersion: as-parsed. */
export function formatSdkVersion(v: SdkVersion): string {
  return v.raw;
}
