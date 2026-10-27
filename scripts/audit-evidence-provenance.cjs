'use strict';
/**
 * Evidence provenance auditor (scripts/audit-evidence-provenance.cjs)
 *
 * Semantics (schemaVersion 2, decided 2026-10-27 in PR#23 / Issue #20):
 * - An evidence-ds-YYYY-MM directory is a cumulative snapshot exported at one
 *   point in time (docs/SELFFEED.md step "30 天后的动作": copy evidence/ to
 *   ds-<month>). The directory label is a PLAN label the exporter wrote at
 *   copy time - it may predate the labelled month (ds-2026-10/11 were both
 *   exported 2026-09-15, page line "生成于"). Data content - not the label,
 *   not the export time - defines the observation period.
 * - Therefore integrity (bad JSONL, events after the audit clock, events
 *   after the export time, hash drift, label/content contradiction) fails
 *   --strict; freshness gaps (prelabelled, stale, no new data, needs data)
 *   are reported honestly and never fail.
 *
 * Manifest: one provenance-manifest.json per dataset directory (next to raw/,
 * never inside it - raw/ is the verbatim-copy zone). Facts only; no audit
 * verdict is baked in. --write emits manifests plus a deterministic
 * website/evidence-provenance.html index (same input -> same page).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const MONTH_DIR = /^evidence-ds-(\d{4})-(\d{2})$/;
const MANIFEST = 'provenance-manifest.json';
const SCHEMA_VERSION = 2;
// Only integrity statuses fail --strict; freshness lives in dataset.freshness.
const INTEGRITY_FAILURES = new Set([
  'NO_RAW_JSONL', 'MALFORMED_JSONL', 'NO_EVENT_TIMESTAMPS', 'FUTURE_DATED',
  'BACKFILLED', 'CROSS_PERIOD_DATA', 'HASH_MISMATCH', 'MANIFEST_INVALID',
]);
const MANIFEST_REQUIRED = ['schemaVersion', 'datasetDirectory', 'labelledPeriod',
  'periodStart', 'periodEnd', 'exportedAtUtc', 'maxEventTime', 'sourceCommit', 'files'];
const FILE_REQUIRED = ['path', 'sha256', 'nonEmptyLines'];

function eventTimeOf(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  // 'at' sits last: pareto-entries.jsonl rejection records carry their time
  // there and nothing else; ISO/epoch validation keeps other uses of such a
  // short key from being misread.
  for (const key of ['time', 'occurredAt', 'eventTime', 'timestamp', 'createdAt', 'date', 'at']) {
    const value = record[key];
    let d = null;
    if (typeof value === 'number' && Number.isFinite(value)) d = new Date(value >= 1e12 ? value : value * 1000);
    else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:[Tt ][0-9:.+\-Zz]+)?$/.test(value.trim())) d = new Date(value.trim());
    if (d && Number.isFinite(d.getTime())) return d.toISOString();
  }
  return null;
}

function listJsonl(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listJsonl(p) : (e.isFile() && e.name.endsWith('.jsonl') ? [p] : []);
  });
}

function inspect(file, root) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split(/\r?\n/).filter((s) => s.trim());
  const times = [], errors = [];
  for (let i = 0; i < lines.length; i++) {
    try { const t = eventTimeOf(JSON.parse(lines[i])); if (t) times.push(t); }
    catch (e) { errors.push({ line: i + 1, message: String(e.message || e).slice(0, 160) }); }
  }
  times.sort();
  return {
    path: path.relative(root, file).split(path.sep).join('/'),
    sha256: crypto.createHash('sha256').update(raw).digest('hex'),
    bytes: Buffer.byteLength(raw), nonEmptyLines: lines.length,
    recordsWithEventTime: times.length, parseErrorCount: errors.length, parseErrors: errors.slice(0, 20),
    minEventTime: times[0] || null, maxEventTime: times[times.length - 1] || null,
  };
}

function monthBounds(period) {
  const [y, m] = period.split('-').map(Number);
  return {
    start: new Date(Date.UTC(y, m - 1, 1)).toISOString(),
    end: new Date(Date.UTC(y, m, 0, 23, 59, 59, 999)).toISOString(),
  };
}

function pageGeneratedAt(dir) {
  try {
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    const m = /生成于\s*(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(html);
    return m ? m[1] : null;
  } catch { return null; }
}

function gitFirstCommit(root, relDir) {
  try {
    const out = execFileSync('git', ['log', '--diff-filter=A', '--format=%H %aI', '-1', '--', relDir],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = /^([0-9a-f]{40}) (.+)$/.exec(out);
    return m ? { sha: m[1], date: new Date(m[2]).toISOString() } : null;
  } catch { return null; }
}

// exportedAtUtc provenance: the exported page embeds the exporter's own clock
// (self-attested); git first-commit is only an upper bound (the ds dirs all
// landed in the squashed root commit); null means honestly unknown.
function defaultResolveProvenance(dir, root) {
  const page = pageGeneratedAt(dir);
  const git = gitFirstCommit(root, path.relative(root, dir).split(path.sep).join('/'));
  return {
    exportedAtUtc: page,
    exportedAtSource: page ? 'page-generatedAt' : (git ? 'git-first-commit-upper-bound' : 'unknown'),
    sourceCommit: git ? git.sha : null,
    sourceCommitSource: git ? 'git-first-commit' : 'unknown',
    firstCommittedAtUtc: git ? git.date : null,
  };
}

function datasetFingerprint(files) {
  return crypto.createHash('sha256')
    .update(files.map((f) => f.path + ' ' + f.sha256 + '\n').join(''))
    .digest('hex').slice(0, 16);
}

function loadManifest(dir) {
  const p = path.join(dir, MANIFEST);
  if (!fs.existsSync(p)) return { present: false };
  try {
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!m || typeof m !== 'object' || m.schemaVersion !== SCHEMA_VERSION) return { present: true, invalid: 'schemaVersion must be ' + SCHEMA_VERSION };
    for (const k of MANIFEST_REQUIRED) if (!(k in m)) return { present: true, invalid: 'missing field ' + k };
    if (!Array.isArray(m.files) || m.files.some((f) => FILE_REQUIRED.some((k) => !(k in f)))) return { present: true, invalid: 'files[] entries missing required fields' };
    return { present: true, manifest: m };
  } catch (e) { return { present: true, invalid: 'unparseable JSON: ' + String(e.message || e).slice(0, 120) }; }
}

function verifyManifest(loaded, facts, resolve) {
  if (loaded.invalid) return 'MANIFEST_INVALID';
  const m = loaded.manifest;
  const actual = facts.files.map((f) => f.path + ' ' + f.sha256 + ' ' + f.nonEmptyLines).sort();
  const recorded = m.files.map((f) => f.path + ' ' + f.sha256 + ' ' + f.nonEmptyLines).sort();
  if (actual.join('\n') !== recorded.join('\n')) return 'HASH_MISMATCH';
  // data-derived semantics must agree when the raw files are untouched;
  // a drifting exportedAtUtc means the attestation source changed under us
  if (m.exportedAtUtc !== resolve.exportedAtUtc) return 'MANIFEST_INVALID';
  return null;
}

function classifyFreshness({ max, files, labelStart, labelEnd, exportedAtUtc, now, prev }) {
  if (!max) return { code: 'NO_EVENT_TIMESTAMPS', reason: 'No event timestamps found.' };
  if (exportedAtUtc && exportedAtUtc < labelStart) return {
    code: 'PRELABELLED',
    reason: 'Exported ' + exportedAtUtc.slice(0, 10) + ', before label month ' + labelStart.slice(0, 7) + ' began - the directory name is a forward-dated plan label; observation actually ends ' + max.slice(0, 10) + '.',
  };
  if (max >= labelStart) return { code: 'CURRENT', reason: 'Data covers the labelled month.' };
  if (now.getTime() < new Date(labelEnd).getTime()) return {
    code: 'NEEDS-DATA',
    reason: 'No events inside ' + labelStart.slice(0, 7) + ' yet; that month is still open (latest event ' + max.slice(0, 10) + ').',
  };
  if (prev && sameFiles(prev.files, files)) return {
    code: 'NO_NEW_DATA',
    reason: 'Byte-identical to previous snapshot ' + prev.dir + ' - a re-export with zero new events.',
  };
  return {
    code: 'STALE',
    reason: 'Label month ' + labelStart.slice(0, 7) + ' has ended with no events in it; data was already ' +
      Math.round((new Date(labelStart) - new Date(max)) / 86400000) + ' days old at the month boundary.',
  };
}

function sameFiles(a, b) {
  // align by file name across directories - raw/log.jsonl in one snapshot
  // compares against raw/log.jsonl in its predecessor
  const key = (f) => f.path.split('/').pop() + ' ' + f.sha256;
  const ka = a.map(key).sort().join('\n');
  const kb = b.map(key).sort().join('\n');
  return ka === kb && ka.length > 0;
}

function auditDataset(dir, root, now, prev, options) {
  const base = path.basename(dir), m = MONTH_DIR.exec(base);
  if (!m) return null;
  const period = m[1] + '-' + m[2];
  const resolve = (options.resolveProvenance || defaultResolveProvenance)(dir, root);
  const files = listJsonl(path.join(dir, 'raw')).map((f) => inspect(f, root));
  const mins = files.map((f) => f.minEventTime).filter(Boolean).sort();
  const maxs = files.map((f) => f.maxEventTime).filter(Boolean).sort();
  const min = mins[0] || null, max = maxs[maxs.length - 1] || null;
  const parseErrors = files.reduce((n, f) => n + f.parseErrorCount, 0);
  const bounds = monthBounds(period);

  let status = 'OK', reason = 'Intact: hashes, times and labels consistent.';
  if (!files.length) { status = 'NO_RAW_JSONL'; reason = 'No raw JSONL files found; period cannot be verified.'; }
  else if (parseErrors) { status = 'MALFORMED_JSONL'; reason = parseErrors + ' JSONL parse error(s) require inspection.'; }
  else if (!max) { status = 'NO_EVENT_TIMESTAMPS'; reason = 'No recognized event timestamps found in raw files.'; }
  else if (new Date(max) > now) { status = 'FUTURE_DATED'; reason = 'Latest event ' + max + ' is later than the audit clock ' + now.toISOString() + '.'; }
  else if (resolve.exportedAtUtc && new Date(max) > new Date(resolve.exportedAtUtc)) { status = 'BACKFILLED'; reason = 'Latest event ' + max + ' is later than the export time ' + resolve.exportedAtUtc + ' - data was changed after export.'; }
  else if (new Date(max) > new Date(bounds.end)) { status = 'CROSS_PERIOD_DATA'; reason = 'Latest event ' + max.slice(0, 7) + ' falls after labelled month ' + period + '; directory label contradicts its content.'; }

  const loaded = loadManifest(dir);
  const manifestIssue = status === 'OK' && loaded.present ? verifyManifest(loaded, { files }, resolve) : null;
  if (manifestIssue === 'MANIFEST_INVALID') { status = 'MANIFEST_INVALID'; reason = 'Manifest is present but not trustworthy: ' + (loaded.invalid || 'recorded exportedAtUtc disagrees with the page/git attestation'); }
  else if (manifestIssue === 'HASH_MISMATCH') { status = 'HASH_MISMATCH'; reason = 'Raw files disagree with the hashes recorded in ' + MANIFEST + '.'; }

  let freshness = { code: 'UNVERIFIED', reason: 'Freshness not assessed (integrity failure).', };
  if (status === 'OK') freshness = classifyFreshness({ max, files, labelStart: bounds.start, labelEnd: bounds.end, exportedAtUtc: resolve.exportedAtUtc, now, prev });

  return {
    schemaVersion: SCHEMA_VERSION,
    datasetDirectory: base,
    labelledPeriod: period,
    periodStart: min, periodEnd: max,
    exportedAtUtc: resolve.exportedAtUtc, exportedAtSource: resolve.exportedAtSource,
    firstCommittedAtUtc: resolve.firstCommittedAtUtc,
    sourceCommit: resolve.sourceCommit, sourceCommitSource: resolve.sourceCommitSource,
    datasetFingerprint: files.length ? datasetFingerprint(files) : null,
    status, reason,
    freshness: freshness.code, freshnessReason: freshness.reason,
    eventRange: { min, max, recordsWithEventTime: files.reduce((n, f) => n + f.recordsWithEventTime, 0) },
    manifestPresent: loaded.present,
    files,
  };
}

function auditEvidenceRoot(root, options = {}) {
  if (!fs.existsSync(root)) throw new Error('Evidence root does not exist: ' + root);
  const now = options.now || new Date();
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && MONTH_DIR.test(e.name))
    .map((e) => path.join(root, e.name));
  const datasets = [];
  for (const dir of entries.sort()) {
    const prevDir = datasets[datasets.length - 1];
    const prev = prevDir ? { dir: prevDir.datasetDirectory, max: prevDir.eventRange.max, files: prevDir.files } : null;
    const d = auditDataset(dir, root, now, prev, options);
    if (d) datasets.push(d);
  }
  return { schemaVersion: SCHEMA_VERSION, auditedAtUtc: now.toISOString(), root: path.resolve(root), datasetCount: datasets.length, datasets };
}

function manifestPayload(d) {
  return {
    schemaVersion: d.schemaVersion,
    datasetDirectory: d.datasetDirectory,
    labelledPeriod: d.labelledPeriod,
    periodStart: d.periodStart, periodEnd: d.periodEnd,
    exportedAtUtc: d.exportedAtUtc, exportedAtSource: d.exportedAtSource,
    firstCommittedAtUtc: d.firstCommittedAtUtc,
    sourceCommit: d.sourceCommit, sourceCommitSource: d.sourceCommitSource,
    datasetFingerprint: d.datasetFingerprint,
    maxEventTime: d.eventRange.max,
    files: d.files.map((f) => ({
      path: f.path, sha256: f.sha256, bytes: f.bytes, nonEmptyLines: f.nonEmptyLines,
      recordsWithEventTime: f.recordsWithEventTime,
      minEventTime: f.minEventTime, maxEventTime: f.maxEventTime,
    })),
  };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function provenancePage(report) {
  const rows = report.datasets.map((d) => {
    const files = d.files.map((f) => '<tr><td><code>' + esc(f.path) + '</code></td><td><code>' + esc(f.sha256.slice(0, 16)) + '…</code></td><td>' + f.nonEmptyLines + '</td><td>' + f.recordsWithEventTime + '</td><td>' + (f.minEventTime ? esc(f.minEventTime.slice(0, 10)) : '—') + ' → ' + (f.maxEventTime ? esc(f.maxEventTime.slice(0, 10)) : '—') + '</td></tr>').join('');
    return '<h2>' + esc(d.datasetDirectory) + ' <span class="st">' + esc(d.status) + '</span> <span class="fr">' + esc(d.freshness) + '</span></h2>' +
      '<table><tr><th>标签期(计划)</th><th>观测期(数据决定)</th><th>导出时间</th><th>首次入库</th><th>sourceCommit</th></tr>' +
      '<tr><td>' + esc(d.labelledPeriod) + '</td><td>' + esc(d.periodStart || '—') + ' → ' + esc(d.periodEnd || '—') + '</td><td>' + esc(d.exportedAtUtc || 'unknown') + ' <span class="dim">(' + esc(d.exportedAtSource) + ')</span></td><td>' + esc(d.firstCommittedAtUtc || 'unknown') + '</td><td><code>' + esc(d.sourceCommit ? d.sourceCommit.slice(0, 10) : 'unknown') + '</code></td></tr></table>' +
      '<p class="note">' + esc(d.freshnessReason) + ' 指纹 <code>' + esc(d.datasetFingerprint || '—') + '</code></p>' +
      '<table><tr><th>文件</th><th>sha256(前 16)</th><th>行数</th><th>带时间样本</th><th>事件范围</th></tr>' + files + '</table>';
  }).join('');
  return '<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<title>hmharness · 证据血缘索引(evidence provenance)</title><style>' +
    'body{background:#081527;color:#DCE8F2;font-family:"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;margin:0;line-height:1.65}' +
    '.wrap{max-width:1000px;margin:0 auto;padding:32px 24px}a{color:#4FD8EB}h1{font-size:24px}h2{font-size:18px;color:#4FD8EB;border-bottom:1px solid rgba(79,216,235,.22);padding-bottom:6px;margin-top:36px}' +
    'table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid rgba(79,216,235,.22);padding:5px 9px;text-align:left}th{color:#8FA8C0;font-weight:600}' +
    '.note{color:#8FA8C0;font-size:13px}code{background:rgba(79,216,235,.08);padding:1px 5px;border-radius:4px;word-break:break-all}' +
    '.st{font-size:13px;color:#5dd39e}.fr{font-size:13px;color:#e0b34c}.dim{color:#8FA8C0}' +
    '</style></head><body><div class="wrap"><h1>hmharness 证据血缘索引</h1>' +
    '<p class="note">语义:目录名 ds-YYYY-MM 是导出时写下的<b>计划标签</b>(可为未来月份);<b>观测期 periodStart/periodEnd 由数据内容决定</b>;导出时间独立记录(来源:页面自证 generatedAt,或 git 首次入库上界)。数据无新增时如实标注 PRELABELLED / STALE / NO_NEW_DATA / NEEDS-DATA。原始 JSONL 永不改写;本页与各目录 provenance-manifest.json 由 <code>node scripts/audit-evidence-provenance.cjs website --write</code> 确定性生成。</p>' +
    rows +
    '<footer style="margin-top:48px;color:#8FA8C0;font-size:12px;border-top:1px solid rgba(79,216,235,.22);padding-top:14px">hmharness evidence provenance · regenerated by scripts/audit-evidence-provenance.cjs --write</footer>' +
    '</div></body></html>';
}

function writeManifests(report) {
  for (const d of report.datasets) {
    const target = path.join(report.root, d.datasetDirectory, MANIFEST);
    fs.writeFileSync(target, JSON.stringify(manifestPayload(d), null, 2) + '\n', 'utf8');
  }
  fs.writeFileSync(path.join(report.root, 'evidence-provenance.html'), provenancePage(report), 'utf8');
}

function main(argv = process.argv.slice(2)) {
  const args = new Set(argv), pos = argv.find((a) => !a.startsWith('--'));
  const root = path.resolve(pos || path.join(__dirname, '..', 'website'));
  const report = auditEvidenceRoot(root);
  if (args.has('--write')) writeManifests(report);
  for (const d of report.datasets) {
    console.log(d.status.padEnd(20) + (d.freshness || '').padEnd(14) + d.datasetDirectory + ' ' +
      (d.eventRange.min || 'no event time') + ' -> ' + (d.eventRange.max || 'no event time') + ' ' + d.reason +
      (d.freshness && d.freshness !== 'UNVERIFIED' ? ' [' + d.freshness + '] ' + d.freshnessReason : ''));
  }
  if (!report.datasets.length) console.log('NO_DATASET_DIRS: no evidence-ds-YYYY-MM folders found');
  if (args.has('--json')) console.log(JSON.stringify(report, null, 2));
  if (args.has('--strict') && report.datasets.some((d) => INTEGRITY_FAILURES.has(d.status))) process.exitCode = 1;
  return report;
}

module.exports = { eventTimeOf, inspect, auditDataset, auditEvidenceRoot, writeManifests, main, INTEGRITY_FAILURES, manifestPayload, monthBounds, pageGeneratedAt, datasetFingerprint };
if (require.main === module) { try { main(); } catch (e) { console.error('evidence provenance audit failed: ' + String(e.message || e)); process.exitCode = 2; } }
