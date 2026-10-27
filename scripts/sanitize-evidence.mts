/**
 * Clean re-export generator for ALREADY-PUBLISHED experiment evidence
 * (root-cause fix companion, 2026-10-28).
 *
 * What it does: scans an experiment evidence directory for files that still
 * carry the local username, and writes *-sanitized SIDE-CAR copies next to
 * them. The frozen originals are NEVER touched (append-only evidence rule);
 * the side-cars are regenerable artifacts anyone can rebuild with this
 * script. A SANITIZATION.md note records what was produced and why.
 *
 * Usage:  npx tsx scripts/sanitize-evidence.mts <experimentDir>
 *
 * Naming: a leaking top-level DIRECTORY gets a full `<dir>-sanitized/` twin
 * (complete tree, so it stands alone); a leaking top-level FILE gets
 * `<base>.sanitized.<ext>`. Files inside phases/ etc. follow the same
 * directory-twin rule at their own level.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  currentUsername, containsUsername, sanitizeTree, sanitizeFileTo, sanitizedFileName,
} from '../packages/evolution/src/sanitize.ts';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

interface Leak { path: string; rel: string }

function findLeaks(dir: string, username: string): Leak[] {
  const out: Leak[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d).sort()) {
      if (entry === 'SANITIZATION.md' || entry.endsWith('-sanitized')) continue; // our own output
      const p = join(d, entry);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (containsUsername(readFileSync(p), username)) out.push({ path: p, rel: relative(dir, p) });
    }
  };
  walk(dir);
  return out;
}

function main(): void {
  const target = process.argv[2];
  if (!target || !existsSync(target) || !statSync(target).isDirectory()) {
    console.error('usage: npx tsx scripts/sanitize-evidence.mts <experimentDir>');
    process.exit(1);
  }
  const username = currentUsername();
  if (!username) { console.error('could not derive the local username — nothing to sanitize'); process.exit(1); }

  const leaks = findLeaks(target, username);
  if (leaks.length === 0) {
    console.log(`no username occurrences found under ${target} — already clean`);
    return;
  }

  // Group leaks by their TOP-LEVEL ancestor inside the experiment dir: a
  // dirty top-level directory (skills-snapshot, gate-home) gets ONE complete
  // `<dir>-sanitized/` twin so it stands alone; a dirty top-level file
  // (manifest.json) gets a `<base>.sanitized.<ext>` side-car. Deep leaks are
  // covered by their ancestor's twin — no scattered side-cars mid-tree.
  const topAncestor = (rel: string): string => rel.split(/[\\/]/)[0]!;
  const dirtyTop = new Set(leaks.map((l) => topAncestor(l.rel)));
  const produced: Array<{ kind: 'dir' | 'file'; src: string; dst: string; replaced: number }> = [];
  for (const name of [...dirtyTop].sort()) {
    const src = join(target, name);
    if (statSync(src).isDirectory()) {
      const dst = join(target, `${name}-sanitized`);
      rmSync(dst, { recursive: true, force: true });
      const res = sanitizeTree(src, dst, username);
      produced.push({ kind: 'dir', src, dst, replaced: res.filesReplaced });
    } else {
      const dst = join(target, sanitizedFileName(name));
      const { replaced } = sanitizeFileTo(src, dst, username);
      produced.push({ kind: 'file', src, dst, replaced: replaced ? 1 : 0 });
    }
  }

  const lines = [
    '# SANITIZATION — clean re-export of frozen evidence',
    '',
    `Generated: ${new Date().toISOString()} by \`scripts/sanitize-evidence.mts\` (repo commit below).`,
    '',
    '## Why',
    '',
    'The publish hook blocks any pushed content containing the local Windows username.',
    'The frozen originals in this directory predate the export-time sanitization fix and',
    'carry the username inside absolute paths (`C:\\Users\\<name>\\` etc.) and bare mentions.',
    'Per the append-only evidence rule the frozen data is NOT rewritten; instead this',
    'script emits side-car `*-sanitized` copies with every username occurrence replaced',
    'by the `<user>` placeholder (case-insensitive, covers all path spellings).',
    'Byte-level fidelity of everything EXCEPT the username token is preserved.',
    '',
    '## What was produced',
    '',
    '| kind | sanitized copy | files with replacements |',
    '|---|---|---|',
    ...produced.map((p) => {
      const where = relative(target, p.dst).split('\\').join('/');
      return `| ${p.kind} | ${where} | ${p.replaced} |`;
    }),
    '',
    '## Verification',
    '',
    'Re-run `npx tsx scripts/sanitize-evidence.mts <thisDir>` from the repo root:',
    'it is idempotent (side-cars are rebuilt, originals untouched), and after it runs',
    'a case-insensitive scan for the username over the `*-sanitized` outputs finds nothing.',
    '',
    '## Originals',
    '',
    'The frozen originals are unchanged — datasetHash / fingerprints recorded in',
    '`manifest.json` and the reports still verify against them, not against these copies.',
  ].join('\n');
  writeFileSync(join(target, 'SANITIZATION.md'), lines + '\n', 'utf8');

  console.log(`sanitized ${leaks.length} leaking files into ${produced.length} side-car outputs:`);
  for (const p of produced) console.log(`  [${p.kind}] ${relative(target, p.dst)} (${p.replaced} replaced)`);
  console.log(`note written: ${join(target, 'SANITIZATION.md')}`);
}

main();
