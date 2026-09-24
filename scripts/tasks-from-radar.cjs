/**
 * Task pool external signal injector (scripts/tasks-from-radar.cjs)
 *
 * Review finding #1 (the deepest): the SELFFEED fitness landscape is
 * self-referential - task pool, bench cases, and evaluation all originate
 * from the same author. This script converts the ops radar's ecosystem
 * brief into candidate tasks, giving the evolution loop an EXTERNAL anchor:
 * real upstream changes generate real agent tasks, breaking the loop of
 * "optimizing for problems I already know the answer to."
 *
 * Usage: node scripts/tasks-from-radar.cjs [--dry-run]
 * Reads:  HMH_HOME/ops/briefs/<latest>.md (the radar brief)
 * Writes: one task JSON line to scripts/selffeed-tasks-ext.jsonl (external pool)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.HMH_HOME || path.join(os.homedir(), '.hmharness');
const BRIEFS_DIR = path.join(HOME, 'ops', 'briefs');
const OUT_FILE = path.join(__dirname, '..', 'scripts', 'selffeed-tasks-ext.jsonl');
const DRY = process.argv.includes('--dry-run');

// find the latest brief
let files;
try { files = fs.readdirSync(BRIEFS_DIR).filter((f) => f.endsWith('.md')).sort(); } catch { files = []; }
if (files.length === 0) {
  console.log('no radar briefs found - run "hmh ops scan" first');
  process.exit(0);
}
const briefPath = path.join(BRIEFS_DIR, files[files.length - 1]);
const brief = fs.readFileSync(briefPath, 'utf8');
console.log(`reading brief: ${files[files.length - 1]} (${brief.length} chars)`);

// extract "值得关注" items as task seeds
const tasks = [];
const concernSection = brief.split('## 值得关注')[1]?.split('##')[0] ?? '';
for (const line of concernSection.split('\n')) {
  const m = line.match(/^-\s*\*?\*?(.+?)\*?\*?[::](.+)$/);
  if (!m) continue;
  const repo = m[1].trim();
  const change = m[2].trim().replace(/\*\*/g, '').slice(0, 200);
  if (!change || change.length < 10) continue;
  // convert each upstream change into a verification task
  tasks.push({
    source: 'radar',
    briefDate: files[files.length - 1].replace('.md', ''),
    repo,
    change,
    task: `Check if "${change}" (from ${repo}, detected by ecosystem radar) affects our HarmonyOS toolchain or scaffolded apps. Run harmony_toolchain_check and harmony_schema_check on a fresh scaffold to verify compatibility. Report any breaking changes.`,
  });
}

if (tasks.length === 0) {
  console.log('no actionable items in the latest brief (all "本期无变更")');
  process.exit(0);
}

if (DRY) {
  console.log(`[dry-run] would write ${tasks.length} tasks:`);
  for (const t of tasks) console.log(`  [${t.repo}] ${t.task.slice(0, 100)}...`);
  process.exit(0);
}

// append (not overwrite) to the external task pool
const existing = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : '';
const newOnes = tasks.filter((t) => !existing.includes(t.task.slice(0, 80)));
if (newOnes.length === 0) {
  console.log('all tasks already in the pool (dedup by first 80 chars)');
  process.exit(0);
}
fs.appendFileSync(OUT_FILE, newOnes.map((t) => JSON.stringify(t)).join('\n') + '\n');
console.log(`wrote ${newOnes.length} external task(s) to scripts/selffeed-tasks-ext.jsonl`);
console.log('next SELFFEED cycle: mix these with the internal pool to break the self-referential landscape');
