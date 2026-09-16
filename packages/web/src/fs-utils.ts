/**
 * @hmharness/web - fs-utils
 * Pure helpers backing the workspace file search/read API and task-submission
 * assembly (attachments + image prefixes). No side effects, no server state -
 * extracted from server.ts so tests import this module without booting the
 * HTTP server (which pulls in page.ts and the whole agent stack).
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Directory names the workspace search never descends into. */
export const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', '.next', '.cache']);

/** Depth cap for the search walk. */
export const MAX_SEARCH_DEPTH = 12;

/** Entry budget for one search (directories included); overflow truncates. */
export const MAX_SEARCH_ENTRIES = 3000;

/** Results returned per search. */
export const MAX_SEARCH_RESULTS = 20;

/** One fuzzy-search hit (files only - @references insert file paths). */
export interface SearchHit {
  /** root-relative path, /-separated */
  rel: string;
  /** absolute path */
  path: string;
  kind: 'file' | 'dir';
}

/** Resolve + normalize for comparison. win32 filesystems are
 *  case-insensitive, so lower-case there; posix compares exactly. */
export function normalizePath(p: string): string {
  const r = resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/**
 * True when `p` resolves to `root` itself or a descendant. Rejects `../`
 * escapes, sibling-prefix paths (`/a/rootish` vs `/a/root`) and other
 * drives (win32). Symlinks are NOT resolved here - callers stat entries
 * when that matters.
 */
export function insideRoot(root: string, p: string): boolean {
  const r = normalizePath(root);
  const t = normalizePath(p);
  if (t === r) return true;
  const rel = relative(r, t);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false; // different drive (win32)
  if (rel === '..' || rel.startsWith(`..${sep}`)) return false;
  return true;
}

/** root-relative, /-separated display path for an absolute path under root. */
export function toRel(root: string, abs: string): string {
  return relative(resolve(root), resolve(abs)).split(sep).join('/');
}

/** Case-insensitive subsequence test: every query char appears in order. */
export function isSubsequence(query: string, text: string): boolean {
  const q = query.toLowerCase();
  const s = text.toLowerCase();
  let qi = 0;
  for (const ch of s) {
    if (ch === q[qi]) qi++;
    if (qi >= q.length) return true;
  }
  return qi >= q.length;
}

/**
 * Fuzzy-match score for a query against a root-relative, /-separated path.
 * Returns -1 when the query is not a case-insensitive subsequence.
 * Score = matchedChars*2 + sum(runLength^2) + 10 when the whole query also
 * matches inside the basename + (4 - depth) for depth <= 4 (shallow files
 * in the workspace root win). depth counts segments below the root
 * ('a.txt' -> 0, 'src/a.txt' -> 1).
 */
export function fuzzyScore(query: string, rel: string): number {
  const q = query.toLowerCase();
  const s = rel.toLowerCase();
  let qi = 0;
  let matched = 0;
  let run = 0;
  let runSum = 0;
  for (const ch of s) {
    if (qi < q.length && ch === q[qi]) {
      qi++;
      matched++;
      run++;
    } else if (run > 0) {
      runSum += run * run;
      run = 0;
    }
  }
  if (run > 0) runSum += run * run;
  if (qi < q.length) return -1;
  let score = matched * 2 + runSum;
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  if (isSubsequence(q, base)) score += 10;
  const depth = rel.split('/').length - 1;
  if (depth <= 4) score += 4 - depth;
  return score;
}

/** Image attachments are capped at 6 MB after base64 decode. */
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/** data:<png|jpeg|jpg|webp>;base64, only - anything else is refused. */
export const IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

export interface ParsedImage {
  ext: 'png' | 'jpg' | 'webp';
  buffer: Buffer;
}

/**
 * Validate one image dataUrl: format must match IMAGE_DATA_URL_RE and the
 * decoded payload must be non-empty and <= MAX_IMAGE_BYTES. Returns the
 * canonical extension + decoded buffer, or null when invalid.
 */
export function parseImageDataUrl(dataUrl: unknown): ParsedImage | null {
  if (typeof dataUrl !== 'string') return null;
  const m = IMAGE_DATA_URL_RE.exec(dataUrl);
  if (!m) return null;
  const ext = (m[1] === 'jpeg' ? 'jpg' : m[1]) as 'png' | 'jpg' | 'webp';
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return null;
  return { ext, buffer };
}

/**
 * @-reference prefix for task submission. Empty (or all-empty) input yields
 * '' so callers can unconditionally concatenate.
 *
 *   [referenced files]
 *   - src/a.ts
 *   - README.md
 *
 */
export function buildAttachmentsPrefix(rels: string[]): string {
  const clean = rels.filter((r) => r.length > 0);
  if (clean.length === 0) return '';
  return `[referenced files]\n${clean.map((r) => `- ${r}`).join('\n')}\n\n`;
}

/**
 * One attached-image block (1-based index). `description: null` is the
 * "no vision provider configured" variant.
 *
 *   [attached image 1: shot.png]
 *   <description>
 *
 */
export function buildImagePrefix(index: number, name: string, description: string | null): string {
  if (description !== null) return `[attached image ${index}: ${name}]\n${description}\n\n`;
  return `[attached image ${index}: ${name}] (no vision provider configured)\n\n`;
}

/** First-N-bytes binary sniff: NUL, or >5% control bytes, means binary. */
export function isBinaryHead(head: Buffer): boolean {
  if (head.includes(0)) return true;
  let ctrl = 0;
  for (const byte of head) {
    // allow \t \n \v \f \r; every other <0x20 byte counts as control
    if (byte < 0x20 && byte !== 9 && byte !== 10 && byte !== 11 && byte !== 12 && byte !== 13) ctrl++;
  }
  return ctrl > head.length * 0.05;
}
