/**
 * Reproducibility packager (audit 03 / P2-1): turn a PASSED-GATE experiment
 * into a self-contained directory an EXTERNAL reviewer can run from any
 * fresh directory — no repo, no API keys, no network — and get the SAME
 * pre-registered verdict, checked field-by-field against the published one.
 *
 *   node --import tsx scripts/make-repro-pack.mts <experiment-id>
 *
 * What lands in repro-packs/<exp-id>/:
 *   - the frozen analyzer script, byte-identical (it resolves its own paths
 *     relative to import.meta.dirname, so the pack mirrors the repo layout
 *     slice it needs: scripts/ + the lib files it imports + its evidence
 *     read-set; nothing is rewritten)
 *   - the frozen INPUT data (skill-gen: a corpus snapshot projected to the
 *     exact fields the experiment consumes; three-arm-v2: the phases/ data
 *     the offline analyzer reads)
 *   - published/ — frozen copies of the verdict artifacts being reproduced
 *   - verdict-rules.md — the pre-registered decision rules, extracted
 *     VERBATIM from the experiment's frozen manifest.json
 *   - env-fingerprint.json — node version, dataset hashes, seeds
 *   - README.md — the one-command reproduction guide
 *   - reproduce.cjs + compare.cjs + compare-lib.cjs — run the analyzer, then
 *     diff every verdict field against published/ and print IDENTICAL/DIFF
 *   - manifest.json — content-addressable index (sha256 over CRLF-normalized
 *     bytes) of every file in the pack, plus the corpus projection contract
 *
 * The packager SELF-TESTS before declaring success: it runs reproduce.cjs
 * inside the fresh pack and requires IDENTICAL. A pack that cannot reproduce
 * its own published verdict is refused, not shipped.
 *
 * Corpus note (skill-gen): the live trajectory store is append-only and has
 * grown since the experiment ran. The packer reconstructs the freeze-time
 * corpus by dropping newest-started trajectories until the dataset hash
 * equals the one frozen in the experiment manifest (greedy drop over an
 * append-only store is exact), then verifies per-family counts against the
 * same manifest before projecting.
 */
import { loadTrajectories } from '../packages/cognitive/src/index.ts';
import type { CognitiveTrajectory } from '../packages/cognitive/src/index.ts';
import { createHash } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const core = await import('./repro-pack-core.cjs') as typeof import('./repro-pack-core.cjs');

/* ---------------- recipes: exactly the two audited experiments ---------------- */

interface FilePair { src: string; dest: string }
interface OutputSpec { path: string; kind: 'json' | 'text'; volatile: string[]; whyVolatile?: string }

interface Recipe {
  experimentId: string;
  analyzer: FilePair;
  libFiles: FilePair[];
  libDirs: Array<FilePair & { excludeTests?: boolean }>;
  /** evidence-dir files/dirs the analyzer READS (relative to the experiment dir) */
  evidenceReads: string[];
  /** evidence-dir content deliberately NOT mirrored, with the reason on record */
  evidenceExcluded: Array<{ path: string; reason: string }>;
  /** extra files the analyzer WRITES that are not compared (with reason) */
  extraOutputs?: Array<{ path: string; reason: string }>;
  outputs: OutputSpec[];
  corpus?: {
    families: string[];
    datasetHashPointer: string;
    familyCountsPointer: string;
    limit: number;
  };
  verdictRules: { pointer: string; intro: string };
  publishedVerdictFrom: (manifestJson: Record<string, unknown>) => Record<string, unknown>;
}

const SKILL_GEN_ID = 'skill-gen-p1-2-2026-10-28';
const THREE_ARM_ID = 'three-arm-v2-2026-10-28';

const RECIPES: Record<string, Recipe> = {
  [SKILL_GEN_ID]: {
    experimentId: SKILL_GEN_ID,
    analyzer: { src: 'scripts/skillgen-p1-2-experiment.mts', dest: 'scripts/skillgen-p1-2-experiment.mts' },
    // the repo's own module-type marker: without it Node's native type
    // transforms load the mirrored .ts files as CommonJS and crash on `export`
    libFiles: [{ src: 'packages/cognitive/package.json', dest: 'packages/cognitive/package.json' }],
    libDirs: [{ src: 'packages/cognitive/src', dest: 'packages/cognitive/src', excludeTests: true }],
    evidenceReads: [],
    evidenceExcluded: [
      { path: 'REPORT.md', reason: 'human execution report — analyzer output, not input (see deviation 6 in it)' },
      { path: 'machine-verdict.md', reason: 'analyzer OUTPUT being reproduced; frozen copy ships as published/' },
      { path: 'phases/run.json', reason: 'analyzer OUTPUT being reproduced; frozen copy ships as published/' },
      { path: 'phases/analysis.json', reason: 'analyzer OUTPUT being reproduced; frozen copy ships as published/' },
      { path: 'phases/sensitivity-exploratory.txt', reason: 'post-hoc exploratory artifact (manifest deviation 2); the preregistered analyzer never reads it' },
    ],
    outputs: [
      { path: `${EVID(SKILL_GEN_ID)}/phases/run.json`, kind: 'json', volatile: ['generatedAt'], whyVolatile: 'ISO timestamp of the run' },
      { path: `${EVID(SKILL_GEN_ID)}/phases/analysis.json`, kind: 'json', volatile: ['generatedAt', 'wallclockMs'], whyVolatile: 'timestamp + wall-clock ms (machine speed)' },
      { path: `${EVID(SKILL_GEN_ID)}/machine-verdict.md`, kind: 'text', volatile: [] },
    ],
    corpus: {
      families: ['terminal', 'harmonyos', 'browser'],
      datasetHashPointer: 'frozen.corpus.datasetHash',
      familyCountsPointer: 'frozen.families.chosen',
      limit: 2000,
    },
    verdictRules: { pointer: 'preRegistered', intro: 'Verdict enum and rules, frozen BEFORE implementation (commit 1f606f9). Reproduced verbatim from the experiment manifest.' },
    publishedVerdictFrom: () => {
      const analysis = JSON.parse(readFileSync(join(REPO, 'website', 'evidence', 'experiments', SKILL_GEN_ID, 'phases', 'analysis.json'), 'utf8'));
      const run = JSON.parse(readFileSync(join(REPO, 'website', 'evidence', 'experiments', SKILL_GEN_ID, 'phases', 'run.json'), 'utf8'));
      return {
        verdict: analysis.verdict,
        secondaryEndpoint: analysis.secondaryEndpoint,
        selectionChanged: run.families.filter((f: { selectionChanged: boolean }) => f.selectionChanged).length,
        llmTokens: analysis.llmTokens,
        perFamily: Object.fromEntries(run.families.map((f: { family: string; contA: number; contB: number; m1: number; pAtTau: number; holdoutSuccesses: number }) => [f.family, { n: f.holdoutSuccesses, contA: f.contA, contB: f.contB, m1: f.m1, pAtTau: f.pAtTau }])),
      };
    },
  },
  [THREE_ARM_ID]: {
    experimentId: THREE_ARM_ID,
    analyzer: { src: 'scripts/three-arm-v2-analyze.mts', dest: 'scripts/three-arm-v2-analyze.mts' },
    libFiles: [
      { src: 'packages/evolution/package.json', dest: 'packages/evolution/package.json' },
      { src: 'packages/evolution/src/three-arm.ts', dest: 'packages/evolution/src/three-arm.ts' },
      { src: 'packages/evolution/src/three-arm-v2.ts', dest: 'packages/evolution/src/three-arm-v2.ts' },
    ],
    libDirs: [],
    evidenceReads: ['manifest.json', 'phases/0-null.jsonl', 'phases/1-candidates.json', 'phases/2-gate.json', 'phases/3-main.jsonl', 'phases/predictions.jsonl', 'protect/'],
    evidenceExcluded: [
      { path: 'phases/0-outputs/', reason: 'raw per-run model outputs; the analyzer never reads this directory (report text references it by name only)' },
      { path: 'phases/3-outputs/', reason: 'same — raw outputs, not an analyzer input' },
      { path: 'gate-home/', reason: 'isolated gate-home copy used by the experiment DRIVER (phase 2); the offline analyzer never touches it' },
      { path: 'skills-snapshot/', reason: 'frozen skill-library snapshot injected into the arms; driver input, not analyzer input' },
      { path: 'REPORT.md', reason: 'human execution report (it also clobbered the machine report.md on case-insensitive NTFS — on-record deviation); analysis.json is the machine-verdict superset being reproduced' },
    ],
    outputs: [
      { path: `${EVID(THREE_ARM_ID)}/analysis.json`, kind: 'json', volatile: ['generatedAt'], whyVolatile: 'ISO timestamp of the analysis' },
    ],
    extraOutputs: [
      { path: `${EVID(THREE_ARM_ID)}/report.md`, reason: 'regenerated machine report (human-readable rendering of analysis.json); its published twin was clobbered by REPORT.md on NTFS, so no byte-compare target exists — every number in it is diffed via analysis.json' },
    ],
    verdictRules: { pointer: 'preRegistered', intro: 'Promotion gate + verdict semantics, frozen before any run. Reproduced verbatim from the experiment manifest.' },
    publishedVerdictFrom: () => {
      const a = JSON.parse(readFileSync(join(REPO, 'website', 'evidence', 'experiments', THREE_ARM_ID, 'analysis.json'), 'utf8'));
      return { gate: a.gate, mainEndpoint: { comparison: a.mainEndpoint.comparison, split: a.mainEndpoint.split, diff: a.mainEndpoint.diff, significant: a.mainEndpoint.significant, needsData: a.mainEndpoint.needsData }, cDeployable: a.cDeployable, datasetHash: a.datasetHash };
    },
  },
};

function EVID(id: string): string {
  return `website/evidence/experiments/${id}`;
}

function pointerGet(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') throw new Error(`pointer ${dotted} breaks at .${part}`);
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/* ---------------- corpus reconstruction + projection (skill-gen) ---------------- */

const tokenize = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);

/** PII token drop-set (security-review hardening): machine/git usernames must
 *  not survive tokenization into the PUBLISHED corpus. */
function usernameTokens(): string[] {
  const names = new Set<string>();
  try { const u = userInfo().username?.toLowerCase(); if (u && u.length >= 3) names.add(u); } catch { /* OS-dependent */ }
  try {
    const gitName = execFileSync('git', ['config', 'user.name'], { cwd: REPO, encoding: 'utf8' }).trim().toLowerCase();
    if (gitName.length >= 3) for (const part of gitName.split(/\s+/)) if (part.length >= 3) names.add(part);
  } catch { /* no git identity configured */ }
  try {
    const email = execFileSync('git', ['config', 'user.email'], { cwd: REPO, encoding: 'utf8' }).trim().toLowerCase();
    const local = email.split('@')[0];
    if (local && local.length >= 3) names.add(local);
  } catch { /* no git email configured */ }
  if (names.size === 0) throw new Error('PII drop-set derivation failed (no machine/git identity available) — refusing to build: fail closed');
  return [...names];
}

/** Credential markers scanned in the RAW goal text for transparency (counted
 *  into the manifest — raw text is never published; literal key=value shapes
 *  are destroyed by tokenization since =/@/: are separators). */
const CREDENTIAL_MARKERS = ['sk-', 'ghp_', 'gho_', 'ghu_', 'akia', 'begin open', 'private key', 'password=', 'passwd', 'token=', 'api_key', 'apikey', 'secret=', 'bearer '];
function countCredentialMarkers(text: string): number {
  const lower = text.toLowerCase();
  return CREDENTIAL_MARKERS.reduce((n, m) => n + (lower.split(m).length - 1), 0);
}
/** Marker-adjacent material is cut from the RAW text BEFORE tokenization:
 *  'password: hunter2' / 'token=abc' lose the value next to the marker word
 *  (the following whitespace-delimited chunk), because the value itself may
 *  be an arbitrary string no shape rule can catch. */
function stripCredentialAdjacents(raw: string): string {
  let text = raw.replace(/(sk|ghp|gho|ghu|akia)[-_][a-z0-9_]{4,}/gi, ' ');
  text = text.replace(/(password|passwd|secret|token|api[_-]?key|apikey|bearer)\s*[=:]\s*\S+/gi, ' ');
  text = text.replace(/(password|passwd|secret|token|api[_-]?key|apikey|bearer)\s+(?!is|was|to|the|and|for|of|in|on|field|name|error|invalid|wrong|correct|reset|change|prompt|input|mask)\S+/gi, ' ');
  return text;
}

/** Credential-PREFIX + digit token (password1, secret123, sk1234…): dropped
 *  like secret-shaped tokens — a plain English word ('password' with no
 *  digits) is not a credential and stays. */
const CREDENTIAL_PREFIX_RE = /^(sk|ghp|gho|ghu|akia|passwd|password|secret|token|apikey|bearer)[a-z]*\d+[a-z0-9]*$/;
/** INDEPENDENT post-projection validator (must NOT reuse the drop predicate):
 *  stricter thresholds than the drop rule + standalone credential-prefix
 *  fragments (a raw ghp_xxx tokenizes to a lone 'ghp' that carries no digits). */
function assertNoCredentialShapedSurvive(projectedText: string): void {
  const toks = projectedText.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const hits = toks.filter((w) =>
    ['ghp', 'gho', 'ghu', 'akia'].includes(w)
    || CREDENTIAL_PREFIX_RE.test(w)
    || (w.length >= 16 && /[a-z]/.test(w) && /\d/.test(w)));
  if (hits.length > 0) throw new Error(`credential-shaped tokens survived projection: ${hits.slice(0, 5).join(', ')} — refusing to build pack`);
}
/** PII absence proof: none of the derived identity tokens may appear in the
 *  published corpus (the self-test complements this by requiring IDENTICAL). */
function assertNoPiiSurvive(projectedText: string, pii: string[]): void {
  const toks = new Set(projectedText.toLowerCase().split(/[^\p{L}\p{N}]+/u));
  const leaked = pii.filter((p) => toks.has(p));
  if (leaked.length > 0) throw new Error(`PII tokens survived projection (${leaked.length} kinds) — refusing to build pack`);
}

/** Secret-shaped token minimization for the PUBLISHED corpus: long tokens
 *  with several digits are commit hashes / ICP numbers / key-ish strings.
 *  Dropping them is verdict-neutral only if the self-test still says
 *  IDENTICAL — which the packager enforces before shipping. */
const isSecretShaped = (w: string): boolean =>
  (w.length >= 12 && (w.match(/\d/g)?.length ?? 0) >= 4 && /\p{L}/u.test(w))
  || (w.length >= 16 && /\p{L}/u.test(w) && /\d/.test(w)); // base64/encoded blobs with sparse digits

interface CorpusPack {
  lines: string[];
  datasetHash: string;
  familyCounts: Record<string, number>;
  droppedIds: string[];
  redactedTokenCount: number;
  redactedDistinctTokens: number;
  piiTokens: string[];
  rawMarkerHits: number;
}

async function freezeCorpus(recipe: Recipe, expManifest: unknown): Promise<CorpusPack> {
  const cfg = recipe.corpus!;
  const families = cfg.families;
  const targetHash = pointerGet(expManifest, cfg.datasetHashPointer) as string;
  const chosen = pointerGet(expManifest, cfg.familyCountsPointer) as Record<string, { usable: number }>;
  const home = process.env.HMH_HOME ?? join(homedir(), '.hmharness');
  const all = await loadTrajectories(home, cfg.limit);
  let pool = all.filter((t) => t.steps.length > 0 && families.includes(t.environment.id));

  const hashOf = (ts: CognitiveTrajectory[]): string =>
    createHash('sha256')
      .update(families.map((f) => `${f}:${ts.filter((t) => t.environment.id === f).map((t) => t.id).sort().join(',')}`).join('\n'))
      .digest('hex');

  const droppedIds: string[] = [];
  for (let i = 0; i < 64 && hashOf(pool) !== targetHash; i++) {
    let newest = 0;
    for (let j = 1; j < pool.length; j++) {
      const a = pool[j]!, b = pool[newest]!;
      if (a.startedAt > b.startedAt || (a.startedAt === b.startedAt && a.id > b.id)) newest = j;
    }
    droppedIds.push(pool[newest]!.id);
    pool.splice(newest, 1);
  }
  if (hashOf(pool) !== targetHash) {
    throw new Error(`corpus reconstruction failed: dataset hash ≠ ${targetHash} after dropping ${droppedIds.length} newest (append-only assumption broken? refusing)`);
  }
  const familyCounts = Object.fromEntries(families.map((f) => [f, pool.filter((t) => t.environment.id === f).length]));
  for (const f of families) {
    const want = chosen[f]?.usable;
    if (want !== undefined && familyCounts[f] !== want) {
      throw new Error(`corpus reconstruction: family ${f} usable=${familyCounts[f]} but manifest froze ${want}; refusing`);
    }
  }

  // projection: EXACTLY the fields the frozen driver + skill-compiler consume.
  // goal.description is reduced to its tokenize() output (space-joined): that
  // is the only form the experiment ever reads it in.
  const redacted = new Map<string, number>();
  const piiTokens = usernameTokens();
  const isDropped = (w: string): boolean => isSecretShaped(w) || CREDENTIAL_PREFIX_RE.test(w) || piiTokens.includes(w);
  let rawMarkerHits = 0;
  const lines = pool.map((t) => {
    const raw = t.goal?.description ?? '';
    rawMarkerHits += countCredentialMarkers(raw);
    const tokens = tokenize(stripCredentialAdjacents(raw));
    const kept: string[] = [];
    for (const w of new Set(tokens)) {
      if (isDropped(w)) redacted.set(w, (redacted.get(w) ?? 0) + 1);
      else kept.push(w);
    }
    return JSON.stringify({
      id: t.id,
      environment: { id: t.environment.id },
      goal: { description: kept.join(' ') },
      steps: t.steps.map((s) => ({ action: { type: s.action.type }, outcome: s.outcome })),
      metrics: { success: t.metrics.success },
    });
  });
  const joined = lines.join('\n');
  assertNoCredentialShapedSurvive(joined);
  return {
    lines,
    datasetHash: targetHash,
    familyCounts,
    droppedIds,
    redactedTokenCount: [...redacted.values()].reduce((s, n) => s + n, 0),
    redactedDistinctTokens: redacted.size,
    piiTokens,
    rawMarkerHits,
  };
}

/* ---------------- generated pack files ---------------- */

function reproduceCjs(recipe: Recipe): string {
  const useHmh = recipe.corpus !== undefined;
  return `#!/usr/bin/env node
/* Generated by scripts/make-repro-pack.mts — do not edit inside the pack.
 * One-command reproduction: runs the frozen analyzer (Node >= 22.7 native
 * type transforms; no tsx, no repo, no network, no API keys), then the
 * verdict comparator against published/. */
'use strict';
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const pack = __dirname;
const analyzer = ${JSON.stringify(recipe.analyzer.dest)};
const [major, minor] = process.versions.node.split('.').map(Number);
const runners = [];
if (major > 22 || (major === 22 && minor >= 7)) runners.push(['--no-warnings', '--experimental-transform-types']);
runners.push(['--import', 'tsx']); // fallback when tsx is resolvable from the pack
const env = { ...process.env };
${useHmh ? 'env.HMH_HOME = join(pack, "hmh-home");' : ''}
let ok = false;
for (const flags of runners) {
  const r = spawnSync(process.execPath, [...flags, analyzer], { cwd: pack, env, stdio: 'inherit' });
  if (r.status === 0) { ok = true; break; }
  if (r.error) console.error('[reproduce] runner unavailable:', r.error.message);
  else console.error('[reproduce] runner ' + flags.join(' ') + ' exited ' + r.status + '; trying next…');
}
if (!ok) { console.error('[reproduce] FAILED: no runner could execute the analyzer (need Node >= 22.7, or tsx on PATH)'); process.exit(2); }
const cmp = spawnSync(process.execPath, [join(pack, 'compare.cjs')], { cwd: pack, stdio: 'inherit' });
process.exit(cmp.status ?? 2);
`;
}

function compareCjs(): string {
  return `#!/usr/bin/env node
/* Generated by scripts/make-repro-pack.mts — do not edit inside the pack.
 * Field-by-field verdict comparator: fresh outputs vs published/ frozen
 * copies (volatile fields pruned, text compared EOL-normalized), plus a
 * content-integrity check of the pack against its manifest file index. */
'use strict';
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const core = require('./compare-lib.cjs');
const pack = __dirname;
const manifest = JSON.parse(readFileSync(join(pack, 'manifest.json'), 'utf8'));
let fail = 0;

for (const out of manifest.outputs) {
  const freshPath = join(pack, out.path);
  if (!existsSync(freshPath)) {
    console.log('DIFF   ' + out.path + ' — fresh output missing (run node reproduce.cjs first)');
    fail = 1;
    continue;
  }
  const res = out.kind === 'json'
    ? core.compareJsonPair(readFileSync(freshPath), readFileSync(join(pack, out.published)), out.volatile)
    : core.compareTextPair(readFileSync(freshPath), readFileSync(join(pack, out.published)));
  const vol = out.volatile.length ? ' (volatile pruned: ' + out.volatile.join(', ') + ')' : '';
  console.log(res.status + '   ' + out.path + ' vs ' + out.published + vol);
  for (const d of res.diffs.slice(0, 30)) {
    console.log('    ' + d.path);
    console.log('      published: ' + d.expected);
    console.log('      fresh    : ' + d.actual);
  }
  if (res.diffs.length > 30) console.log('    … ' + (res.diffs.length - 30) + ' more field diffs');
  if (res.status !== 'IDENTICAL') fail = 1;
}

const skipVerify = ['manifest.json', ...manifest.outputs.map((o) => o.path), ...(manifest.extraOutputs ?? []).map((o) => o.path)];
const v = core.verifyFileIndex(pack, manifest.fileIndex, { skip: skipVerify });
if (!v.ok) {
  console.log('PACK-INTEGRITY-FAIL');
  for (const p of v.problems) console.log('    ' + p);
  fail = 1;
} else {
  console.log('PACK-INTEGRITY-OK   ' + manifest.fileIndex.length + ' files match manifest.json sha256 index');
}
console.log(fail ? 'RESULT: DIFF' : 'RESULT: IDENTICAL');
process.exit(fail);
`;
}

function readmeMd(recipe: Recipe, manifest: PackManifest): string {
  const pack = manifest;
  const verdict = JSON.stringify(pack.publishedVerdict, null, 2);
  const corpusSection = pack.corpus ? `
## Corpus snapshot (self-contained — your \`~/.hmharness\` is NOT used)

- \`hmh-home/cognitive/trajectories/corpus.jsonl\` — ${pack.corpus.trajectoryCount} usable trajectories of the 3 frozen families, in the exact loader order the published run saw (single file ⇒ readdir order is deterministic on every OS).
- dataset hash (frozen in the experiment manifest): \`${pack.corpus.datasetHash}\` — recomputed at pack time and equal.
- The corpus grew after the experiment ran; the packer dropped the ${pack.corpus.reconstruction.droppedIds.length} newest trajectories (ids in manifest.json → corpus.reconstruction) until the hash matched the freeze-time value, and verified per-family counts (${Object.entries(pack.corpus.familyCounts).map(([f, n]) => `${f}=${n}`).join(', ')}).
- Projection: each trajectory is reduced to the fields the frozen analyzer consumes — \`{id, environment.id, goal.description→tokenized, steps[].action.type/outcome, metrics.success}\`. \`goal.description\` is replaced by its tokenize() output (the only form the experiment reads); ${pack.corpus.projection.goalRedaction.tokenCount} secret-shaped tokens (${pack.corpus.projection.goalRedaction.distinctTokens} distinct: ≥12 chars with ≥4 digits) were dropped. The self-test proves the projection + redaction are verdict-neutral by requiring IDENTICAL.
` : '';
  const excluded = recipe.evidenceExcluded.map((e) => `  - \`${e.path}\` — ${e.reason}`).join('\n');
  return `# Repro pack: ${recipe.experimentId}

External reproduction of the published verdict — from a fresh directory, no hmharness repo, no API keys, no network, deterministic (fixed seeds, zero LLM tokens).

**Published verdict being reproduced:**

\`\`\`json
${verdict}
\`\`\`

## One command

\`\`\`bash
node reproduce.cjs     # Node >= 22.7 (uses native --experimental-transform-types; tsx as fallback)
\`\`\`

It (1) runs the frozen analyzer byte-identical to the repo's \`${recipe.analyzer.src}\` against the frozen input data inside this pack, (2) regenerates the machine-verdict artifacts, (3) diffs every field against the frozen copies in \`published/\`, and (4) verifies the pack's own file integrity against the sha256 index in \`manifest.json\`. Success prints \`RESULT: IDENTICAL\` (exit 0).

\`node compare.cjs\` re-runs only step (3)+(4) without re-running the analyzer.

## What is compared

${manifest.outputs.map((o) => `- \`${o.path}\` (${o.kind}) vs \`${o.published}\`${o.volatile.length ? ` — volatile fields pruned from both sides: ${o.volatile.join(', ')}` : ' — byte-identical after EOL normalization'}`).join('\n')}
${recipe.extraOutputs?.length ? `\nRegenerated but not byte-compared (see manifest.json → extraOutputs):\n${recipe.extraOutputs.map((o) => `- \`${o.path}\` — ${o.reason}`).join('\n')}` : ''}

## Layout

- \`${recipe.analyzer.dest}\` — the frozen analyzer, byte-identical (it resolves its inputs relative to its own location, which is why the pack mirrors a slice of the repo layout).
- \`published/\` — frozen copies of the verdict artifacts + the experiment's preregistration manifest.
- \`verdict-rules.md\` — the pre-registered decision rules (enum-locked), verbatim.
- \`env-fingerprint.json\` — node version, dataset hash(es), seeds.
- \`manifest.json\` — sha256 index of every file (CRLF-normalized basis ⇒ verifiable on any checkout EOL policy) + the full recipe record.
${recipe.corpus ? '- `hmh-home/` — the corpus snapshot; `reproduce.cjs` points `HMH_HOME` here, so the analyzer reads the frozen corpus instead of your home directory.' : '- `website/evidence/experiments/' + recipe.experimentId + '/` — frozen analyzer inputs mirrored from the published evidence (reads only).'}
${excluded ? `\nDeliberately NOT included (analyzer never reads them; honesty list from manifest.json → evidenceExcluded):\n${excluded}` : ''}

## Verdict rules

See \`verdict-rules.md\`: the decision enum and every gate were frozen in the experiment manifest BEFORE implementation; the analyzer's verdict language is generated, not hand-worded.
${corpusSection}
## Honesty clauses

- The comparator prints DIFF and exits non-zero on any field difference — identity is claimed only field-by-field, never "close enough".
- The packager refuses to ship a pack whose self-test does not produce IDENTICAL.
- Corpus/data drift vs the published run is handled by freezing the inputs INSIDE the pack, not by re-running against live data.
`;
}

interface PackManifest {
  kind: 'hmharness-repro-pack';
  version: number;
  experimentId: string;
  generatedAt: string;
  generator: { script: string; repoCommit: string; nodeVersion: string; platform: string };
  publishedVerdict: Record<string, unknown>;
  reproduce: Record<string, unknown>;
  corpus?: {
    families: string[];
    datasetHash: string;
    trajectoryCount: number;
    familyCounts: Record<string, number>;
    reconstruction: { method: string; droppedIds: string[]; verified: boolean };
    projection: {
      fields: string;
      goalRedaction: { rule: string; tokenCount: number; distinctTokens: number; piiTokenCount: number; rawCredentialMarkerHits: number };
    };
  };
  evidenceExcluded: Array<{ path: string; reason: string }>;
  extraOutputs?: Array<{ path: string; reason: string }>;
  outputs: Array<{ path: string; published: string; kind: string; volatile: string[]; whyVolatile?: string }>;
  fileIndex: Array<{ path: string; sha256: string; bytes: number }>;
}

/* ---------------- the packager ---------------- */

const experimentId = process.argv[2];
if (!experimentId || !RECIPES[experimentId]) {
  console.error(`usage: node --import tsx scripts/make-repro-pack.mts <experiment-id>`);
  console.error(`known experiments: ${Object.keys(RECIPES).join(', ')}`);
  process.exit(2);
}
const recipe = RECIPES[experimentId]!;
const expDir = join(REPO, 'website', 'evidence', 'experiments', experimentId);
const expManifest = JSON.parse(readFileSync(join(expDir, 'manifest.json'), 'utf8'));
const outRoot = join(REPO, 'repro-packs', experimentId);

console.log(`packing ${experimentId} → repro-packs/${experimentId}/`);
rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });

// 1. mirrored analyzer + lib slice (byte-identical copies)
const copyIn = (src: string, dest: string) => {
  const target = join(outRoot, dest);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(REPO, src), target);
  try { chmodSync(target, 0o644); } catch { /* read-only source on some FS */ }
};
copyIn(recipe.analyzer.src, recipe.analyzer.dest);
for (const f of recipe.libFiles) copyIn(f.src, f.dest);
for (const d of recipe.libDirs) {
  mkdirSync(join(outRoot, d.dest), { recursive: true });
  const copyDir = (rel: string) => {
    for (const e of readdirSync(join(REPO, d.src, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) copyDir(r);
      else if (d.excludeTests && rel.split('/').includes('__tests__')) continue;
      else copyIn(`${d.src}/${r}`, `${d.dest}/${r}`);
    }
  };
  copyDir('');
}
// libDirs root itself may be empty after exclusion — remove if so
for (const d of recipe.libDirs) {
  const t = join(outRoot, d.dest);
  if (readdirSync(t).length === 0) rmSync(t, { recursive: true });
}

// 2. analyzer output target dir (created empty; reproduce.cjs fills it)
mkdirSync(join(outRoot, EVID(experimentId), 'phases'), { recursive: true });

// 3. evidence read-set mirror (the analyzer reads these relative to its repo-root slice)
for (const rel of recipe.evidenceReads) {
  const src = join(expDir, rel);
  if (!existsSync(src)) throw new Error(`evidence read ${rel} missing in published evidence`);
  const dest = join(outRoot, EVID(experimentId), rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, statSync(src).isDirectory() ? { recursive: true } : undefined);
  if (statSync(src).isDirectory()) {
    // normalize the protect set's 0o444 discipline into hash-frozen copies
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else { try { chmodSync(p, 0o644); } catch { /* best effort */ } }
      }
    };
    walk(dest);
  }
}

// 4. published/ frozen copies of the artifacts under reproduction
mkdirSync(join(outRoot, 'published'));
for (const o of recipe.outputs) {
  const pubRel = o.path.replace(`${EVID(experimentId)}/`, '');
  mkdirSync(dirname(join(outRoot, 'published', pubRel)), { recursive: true });
  cpSync(join(REPO, o.path), join(outRoot, 'published', pubRel));
}
cpSync(join(expDir, 'manifest.json'), join(outRoot, 'published', 'manifest.json'));

// 5. corpus freeze (skill-gen only)
let corpusInfo: CorpusPack | undefined;
if (recipe.corpus) {
  corpusInfo = await freezeCorpus(recipe, expManifest);
  mkdirSync(join(outRoot, 'hmh-home', 'cognitive', 'trajectories'), { recursive: true });
  writeFileSync(join(outRoot, 'hmh-home', 'cognitive', 'trajectories', 'corpus.jsonl'), corpusInfo.lines.join('\n') + '\n');
  console.log(`  corpus frozen: ${corpusInfo.lines.length} trajectories, hash ${corpusInfo.datasetHash.slice(0, 16)}…, redacted ${corpusInfo.redactedTokenCount} tokens (${corpusInfo.redactedDistinctTokens} distinct), dropped ${corpusInfo.droppedIds.length} post-run additions`);
}

// 6. verdict-rules.md — verbatim extraction from the frozen experiment manifest
const rules = pointerGet(expManifest, recipe.verdictRules.pointer);
writeFileSync(
  join(outRoot, 'verdict-rules.md'),
  `# Pre-registered verdict rules — ${experimentId}\n\n${recipe.verdictRules.intro}\n\nExtracted from \`published/manifest.json\` at \`${recipe.verdictRules.pointer}\` (machine copy, no rewording):\n\n\`\`\`json\n${JSON.stringify(rules, null, 2)}\n\`\`\`\n`,
);

// 7. env fingerprint
const [major, minor] = process.versions.node.split('.').map(Number);
writeFileSync(
  join(outRoot, 'env-fingerprint.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      nodeVersionRequired: '>=22.7 (native --experimental-transform-types; tsx fallback)',
      packTime: { node: process.version, platform: process.platform, arch: process.arch },
      determinism: recipe.corpus
        ? { seed: 'real-cycle-2026-10-07 (split), skillgen-p1-2-<family> (bootstrap)', datasetHash: corpusInfo!.datasetHash, llmTokens: 0, network: 'none' }
        : { bootstrapSeed: 42, seeds: [1, 2, 3, 4, 5], datasetHash: (expManifest as { frozen: { taskSet: { datasetHash: string } } }).frozen.taskSet.datasetHash, llmTokens: 'n/a (offline re-analysis of published run records)' },
    },
    null,
    2,
  ) + '\n',
);

// 8. generated runner + comparator + vendored compare lib
writeFileSync(join(outRoot, 'reproduce.cjs'), reproduceCjs(recipe));
writeFileSync(join(outRoot, 'compare.cjs'), compareCjs());
cpSync(join(REPO, 'scripts', 'repro-pack-core.cjs'), join(outRoot, 'compare-lib.cjs'));

// 9. pack manifest (published verdict summary + recipe record + file index)
const manifest: PackManifest = {
  kind: 'hmharness-repro-pack',
  version: 1,
  experimentId,
  generatedAt: new Date().toISOString(),
  generator: {
    script: 'scripts/make-repro-pack.mts',
    repoCommit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO }).toString().trim(),
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
  },
  publishedVerdict: recipe.publishedVerdictFrom(expManifest),
  reproduce: {
    entry: 'node reproduce.cjs',
    analyzer: recipe.analyzer.dest,
    analyzerIsByteIdenticalTo: recipe.analyzer.src,
    ...(recipe.corpus ? { env: { HMH_HOME: 'hmh-home' } } : {}),
  },
  ...(corpusInfo
    ? {
        corpus: {
          families: recipe.corpus!.families,
          datasetHash: corpusInfo.datasetHash,
          trajectoryCount: corpusInfo.lines.length,
          familyCounts: corpusInfo.familyCounts,
          reconstruction: {
            method: 'live corpus is append-only; dropped newest-started trajectories until sha256(family:<sorted ids>) equaled the manifest-frozen datasetHash; verified per-family usable counts',
            droppedIds: corpusInfo.droppedIds,
            verified: true,
          },
          projection: {
            fields: '{id, environment.id, goal.description (tokenized), steps[].action.type, steps[].outcome, metrics.success} — exactly the fields the frozen driver and packages/cognitive/src/skill-compiler.ts consume',
            goalRedaction: {
              rule: 'drop tokens matching ANY of: (a) length>=12 AND >=4 digits AND >=1 letter (commit hashes / registration numbers); (a2) length>=16 with letters AND digits (base64/encoded blobs with sparse digits); (b) credential-prefix+digit shapes (password123, sk1234…); (c) machine/git username tokens (count only — values never published). Pre-tokenization, credential-marker-adjacent material (password: VALUE / token=VALUE / bare-marker next word) is cut from the RAW text. Literal key=value pairs cannot survive tokenization (=, @, : are separators); a post-projection assert enforces that no credential-shaped token remains. Verdict-neutrality of every drop is proven by the pack self-test (RESULT: IDENTICAL required).',
              tokenCount: corpusInfo.redactedTokenCount,
              distinctTokens: corpusInfo.redactedDistinctTokens,
              piiTokenCount: corpusInfo.piiTokens.length,
              rawCredentialMarkerHits: corpusInfo.rawMarkerHits,
            },
          },
        },
      }
    : {}),
  evidenceExcluded: recipe.evidenceExcluded,
  ...(recipe.extraOutputs ? { extraOutputs: recipe.extraOutputs } : {}),
  outputs: recipe.outputs.map((o) => ({
    path: o.path,
    published: 'published/' + o.path.replace(`${EVID(experimentId)}/`, ''),
    kind: o.kind,
    volatile: o.volatile,
    ...(o.whyVolatile ? { whyVolatile: o.whyVolatile } : {}),
  })),
  fileIndex: [],
};
writeFileSync(join(outRoot, 'README.md'), readmeMd(recipe, manifest));
manifest.fileIndex = core.buildFileIndex(outRoot, {
  skip: ['manifest.json', ...manifest.outputs.map((o) => o.path), ...(manifest.extraOutputs ?? []).map((o) => o.path)],
});
writeFileSync(join(outRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// 10. SELF-TEST: the pack must reproduce its own published verdict, from itself
console.log('  self-test: node reproduce.cjs (inside the fresh pack)');
const self = execFileSync(process.execPath, ['reproduce.cjs'], { cwd: outRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
process.stdout.write(self.endsWith('\n') ? self : self + '\n');
if (!/RESULT: IDENTICAL/.test(self)) {
  throw new Error('SELF-TEST FAILED: pack did not reproduce the published verdict (RESULT: IDENTICAL missing in self-test output) — pack refused');
}

// 11. clean generated outputs so the shipped pack starts from zero
for (const o of [...manifest.outputs, ...(manifest.extraOutputs ?? [])]) {
  rmSync(join(outRoot, o.path), { force: true });
}

console.log(`\nPACK READY: repro-packs/${experimentId}/ (${manifest.fileIndex.length} indexed files)`);
console.log(`publish copy: website/repro-packs/${experimentId}/ (this repo's gh-pages source)`);
if (major === 22 && minor < 7) console.log('note: pack-time node < 22.7; self-test used the tsx fallback path');
