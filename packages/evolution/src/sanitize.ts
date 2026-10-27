/**
 * @hmharness/evolution - evidence-export username sanitizer.
 *
 * Root-cause fix for the publish-hook rejections (2026-10-28): experiment
 * exports (skill snapshots, gate-home copies, manifests) carried the local
 * Windows username inside absolute paths and bare mentions, and the repo's
 * pre-push hook blocks any pushed content matching the username. The fix is
 * at the EXPORT pipeline: whatever gets copied into website/evidence has the
 * username replaced by the `<user>` placeholder BEFORE it lands on disk.
 *
 * Design constraints:
 *  - the username is NEVER hardcoded here (this file is itself pushed); it is
 *    passed in by the caller, typically derived from os.homedir()
 *  - replacement is case-insensitive and covers every spelling shape at once:
 *    `C:\Users\<name>\`, `C:/Users/<name>/`, JSON-escaped `C:\\Users\\<name>\\`
 *    and bare mentions — they are all just the username token in context
 *  - already-sanitized text is idempotent (`<user>` contains no username)
 *  - binary files are copied verbatim (never re-encoded)
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

export const PLACEHOLDER = '<user>';

/** The username to strip, derived from the home directory's last segment.
 *  Returned lowercase-free (as-is); matching is case-insensitive anyway. */
export function currentUsername(): string {
  const home = process.env.HMH_HOME_OVERRIDE_FOR_SANITIZER ?? process.env.USERPROFILE ?? process.env.HOME ?? '';
  // USERPROFILE is `C:\Users\<name>`; HOME on unix is `/home/<name>`
  const seg = home.split(/[\\/]/).filter(Boolean).pop() ?? '';
  return seg;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace every case-insensitive occurrence of `username` with `<user>`.
 *  Pure string surgery — no regex feature beyond the escaped literal. */
export function sanitizeText(text: string, username: string): string {
  if (!username || username.length < 2) return text; // refuse to nuke 1-char names
  const re = new RegExp(escapeRegExp(username), 'gi');
  return text.replace(re, PLACEHOLDER);
}

/** Heuristic text/binary split: a NUL byte or a high share of lone-ish
 *  control bytes means binary. Text evidence (md/json/task/jsonl/log/txt)
 *  sails through; png/zips copy verbatim. */
export function isProbablyText(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  let ctrl = 0;
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  for (const b of sample) if (b < 9 || (b > 13 && b < 32)) ctrl++;
  return ctrl / Math.max(1, sample.length) < 0.02;
}

export function sanitizeBuffer(buf: Buffer, username: string): Buffer {
  if (!isProbablyText(buf)) return buf;
  return Buffer.from(sanitizeText(buf.toString('utf8'), username), 'utf8');
}

/** True when the buffer still contains the username (case-insensitive). */
export function containsUsername(buf: Buffer, username: string): boolean {
  if (!username) return false;
  if (!isProbablyText(buf)) return false;
  const re = new RegExp(escapeRegExp(username), 'i');
  return re.test(buf.toString('utf8'));
}

export interface SanitizeTreeResult {
  filesScanned: number;
  filesReplaced: number;
  binaryCopied: number;
}

/** Copy `src` -> `dst` recursively, sanitizing every text file in flight.
 *  The destination is always rebuilt from source (idempotent export). */
export function sanitizeTree(src: string, dst: string, username: string): SanitizeTreeResult {
  const result: SanitizeTreeResult = { filesScanned: 0, filesReplaced: 0, binaryCopied: 0 };
  const walk = (from: string, to: string): void => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from).sort()) {
      const fp = join(from, entry);
      const tp = join(to, entry);
      if (statSync(fp).isDirectory()) { walk(fp, tp); continue; }
      result.filesScanned++;
      const buf = readFileSync(fp);
      if (!isProbablyText(buf)) {
        cpSync(fp, tp); // verbatim binary
        result.binaryCopied++;
        continue;
      }
      const out = sanitizeText(buf.toString('utf8'), username);
      if (out !== buf.toString('utf8')) result.filesReplaced++;
      writeFileSync(tp, out, 'utf8');
    }
  };
  if (!existsSync(src)) throw new Error(`sanitizeTree: source missing: ${src}`);
  walk(src, dst);
  return result;
}

/** Sanitize a single file into `dstPath` (parent dirs created). */
export function sanitizeFileTo(srcPath: string, dstPath: string, username: string): { replaced: boolean } {
  const buf = readFileSync(srcPath);
  const out = sanitizeBuffer(buf, username);
  mkdirSync(dirname(dstPath), { recursive: true });
  writeFileSync(dstPath, out);
  return { replaced: !out.equals(buf) };
}

/** Placeholder twin of basename for sanitized sidecar files:
 *  manifest.json -> manifest.sanitized.json */
export function sanitizedFileName(name: string): string {
  const ext = extname(name);
  const base = basename(name, ext);
  return `${base}.sanitized${ext}`;
}
