'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MONTH_DIR = /^evidence-ds-(\d{4})-(\d{2})$/;
const MANIFEST = 'provenance-manifest.json';

function eventTimeOf(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  for (const key of ['time', 'occurredAt', 'eventTime', 'timestamp', 'createdAt', 'date']) {
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
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listJsonl(p) : (e.isFile() && e.name.endsWith('.jsonl') ? [p] : []);
  });
}
function inspect(file, root) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split(/\r?\n/).filter(s => s.trim());
  const times = [], errors = [];
  for (let i=0; i<lines.length; i++) {
    try { const t = eventTimeOf(JSON.parse(lines[i])); if (t) times.push(t); }
    catch (e) { errors.push({ line: i+1, message: String(e.message || e).slice(0,160) }); }
  }
  times.sort();
  return {
    path: path.relative(root,file).split(path.sep).join('/'),
    sha256: crypto.createHash('sha256').update(raw).digest('hex'),
    bytes: Buffer.byteLength(raw), nonEmptyLines: lines.length,
    recordsWithEventTime: times.length, parseErrorCount: errors.length, parseErrors: errors.slice(0,20),
    minEventTime: times[0] || null, maxEventTime: times[times.length-1] || null,
  };
}
function auditDataset(dir, root, now) {
  const base = path.basename(dir), m = MONTH_DIR.exec(base);
  if (!m) return null;
  const period = m[1] + '-' + m[2];
  const files = listJsonl(path.join(dir,'raw')).map(f => inspect(f,root));
  const mins = files.map(f=>f.minEventTime).filter(Boolean).sort();
  const maxs = files.map(f=>f.maxEventTime).filter(Boolean).sort();
  const min = mins[0] || null, max = maxs[maxs.length-1] || null;
  const parseErrors = files.reduce((n,f)=>n+f.parseErrorCount,0);
  let status='OK', reason='Latest event month matches the directory label.';
  if (!files.length) { status='NO_RAW_JSONL'; reason='No raw JSONL files found; period cannot be verified.'; }
  else if (parseErrors) { status='MALFORMED_JSONL'; reason=String(parseErrors)+' JSONL parse error(s) require inspection.'; }
  else if (!max) { status='NO_EVENT_TIMESTAMPS'; reason='No recognized event timestamps found in raw files.'; }
  else if (max.slice(0,7) < period) { status='STALE'; reason='Latest event is '+max.slice(0,7)+', older than labelled period '+period+'.'; }
  else if (max.slice(0,7) > period) { status='PERIOD_MISMATCH'; reason='Latest event is later than labelled period '+period+'.'; }
  return { schemaVersion:1, datasetDirectory:base, labelledPeriod:period, exportedAtUtc:now.toISOString(), sourceCommit:process.env.GITHUB_SHA || process.env.SOURCE_COMMIT || null, status, reason, eventRange:{min,max,recordsWithEventTime:files.reduce((n,f)=>n+f.recordsWithEventTime,0)}, files };
}
function auditEvidenceRoot(root, options={}) {
  if (!fs.existsSync(root)) throw new Error('Evidence root does not exist: '+root);
  const now=options.now || new Date();
  const datasets=fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory() && MONTH_DIR.test(e.name)).map(e=>auditDataset(path.join(root,e.name),root,now)).filter(Boolean).sort((a,b)=>a.datasetDirectory.localeCompare(b.datasetDirectory));
  return {schemaVersion:1,auditedAtUtc:now.toISOString(),root:path.resolve(root),datasetCount:datasets.length,datasets};
}
function writeManifests(report) {
  for (const d of report.datasets) {
    const target=path.join(report.root,d.datasetDirectory,'raw',MANIFEST);
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target,JSON.stringify(d,null,2)+'\n','utf8');
  }
}
function main(argv=process.argv.slice(2)) {
  const args=new Set(argv), pos=argv.find(a=>!a.startsWith('--'));
  const root=path.resolve(pos || path.join(__dirname,'..','website'));
  const report=auditEvidenceRoot(root);
  if (args.has('--write')) writeManifests(report);
  for (const d of report.datasets) console.log(d.status.padEnd(20)+' '+d.datasetDirectory+' '+(d.eventRange.min || 'no event time')+' -> '+(d.eventRange.max || 'no event time')+' '+d.reason);
  if (!report.datasets.length) console.log('NO_DATASET_DIRS: no evidence-ds-YYYY-MM folders found');
  if (args.has('--json')) console.log(JSON.stringify(report,null,2));
  if (args.has('--strict') && report.datasets.some(d=>d.status!=='OK')) process.exitCode=1;
}
module.exports={eventTimeOf,inspect,auditDataset,auditEvidenceRoot,writeManifests,main};
if (require.main===module) { try { main(); } catch(e) { console.error('evidence provenance audit failed: '+String(e.message||e)); process.exitCode=2; } }
