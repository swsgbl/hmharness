/**
 * Evidence exporter (scripts/export-evidence.cjs)
 * The 30-day self-feeding protocol (docs/SELFFEED.md) publishes what the
 * evolution loop ACTUALLY did - promoted, rejected, spent, idled - so the
 * "self-evolving" claim is auditable instead of asserted. This script reads
 * HMH_HOME (env override honored) and writes:
 *
 *   website/evidence/index.html   standalone page, data inlined, dark theme
 *   website/evidence/raw/*.jsonl  verbatim copies of the source logs
 *
 * Honesty rules baked in: every number comes from a file (never hardcoded),
 * absent sources are listed as absent (never zero-filled silently), and the
 * embedded raw log is truncated only with an explicit truncation note.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.HMH_HOME || path.join(os.homedir(), '.hmharness');
const OUT = path.join(__dirname, '..', 'website', 'evidence-new');

const readJsonl = (p) => {
  try {
    return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return null; }
};
const listDirs = (p) => {
  try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { return null; }
};
const STATES = ['active', 'canary', 'draft', 'archive'];
const listSkills = (state) => listDirs(path.join(HOME, 'skills', state)) ?? [];
// top-level skills/<name> (manually installed / legacy) count as active too -
// listSkills() in evolution/skills.ts scans them the same way
const top = (listDirs(path.join(HOME, 'skills')) ?? []).filter((n) => !STATES.includes(n));
const skills = {
  active: [...new Set([...top, ...listSkills('active')])],
  canary: listSkills('canary'),
  draft: listSkills('draft'),
  archive: listSkills('archive'),
};
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

// ---- collect ----
const logLines = readJsonl(path.join(HOME, 'evolution', 'log.jsonl'));
const pareto = readJsonl(path.join(HOME, 'evolution', 'pareto', 'entries.jsonl'));
const insights = readJsonl(path.join(HOME, 'insights', 'insights.jsonl'));
const memoryMd = readText(path.join(HOME, 'memory', 'memory.md'));
let benchCases = null;
// bench.ts writes .task files - counting .txt/.json here zero-filled the
// evidence page (3 real cases displayed as 0), violating the exporter's own
// honesty rule. Count every case file and surface the directory name.
try { benchCases = fs.readdirSync(path.join(HOME, 'bench', 'cases')).filter((f) => /\.(task|txt|json)$/.test(f)).length; } catch { /* absent */ }

const cyclesByDay = {};
const outcomes = [];      // {time, name, action, reason} - the honesty table
if (logLines) {
  for (const l of logLines) {
    const day = String(l.time ?? '').slice(0, 10);
    if (day) cyclesByDay[day] = (cyclesByDay[day] ?? 0) + 1;
    for (const o of l.outcomes ?? []) {
      outcomes.push({ time: l.time ?? '', name: o.name ?? o.skill ?? '?', action: o.action ?? '?', reason: o.reason ?? o.detail ?? '' });
    }
  }
}

const memoryNotes = memoryMd === null ? null : (memoryMd.match(/^- /gm) ?? []).length;
const rawLog = readText(path.join(HOME, 'evolution', 'log.jsonl')) ?? '';
const RAW_CAP = 400_000;
const rawLogEmbedded = rawLog.length > RAW_CAP
  ? rawLog.slice(0, RAW_CAP) + `\n...[TRUNCATED at ${RAW_CAP} chars of ${rawLog.length}; full file at raw/log.jsonl]`
  : rawLog || '(log empty or absent)';

const DATA = {
  generatedAt: new Date().toISOString(),
  homeSource: HOME,
  cycles: logLines === null ? null : logLines.length,
  firstCycle: logLines?.[0]?.time ?? null,
  lastCycle: logLines?.[logLines.length - 1]?.time ?? null,
  cyclesByDay,
  skills,
  insights: insights === null ? null : insights.length,
  recentInsights: (insights ?? []).slice(-8).reverse().map((i) => ({ time: i.time ?? '', text: String(i.text ?? i.insight ?? JSON.stringify(i)).slice(0, 160) })),
  memoryNotes,
  benchCases,
  paretoRejected: (pareto ?? []).map((e) => ({ time: e.time ?? '', name: e.name ?? '?', reason: String(e.reason ?? e.rejectedReason ?? '').slice(0, 200) })),
  outcomes,
};

// ---- write raw copies (verbatim, full fidelity) ----
fs.mkdirSync(path.join(OUT, 'raw'), { recursive: true });
if (logLines !== null) fs.copyFileSync(path.join(HOME, 'evolution', 'log.jsonl'), path.join(OUT, 'raw', 'log.jsonl'));
if (pareto !== null) fs.copyFileSync(path.join(HOME, 'evolution', 'pareto', 'entries.jsonl'), path.join(OUT, 'raw', 'pareto-entries.jsonl'));
if (insights !== null) fs.copyFileSync(path.join(HOME, 'insights', 'insights.jsonl'), path.join(OUT, 'raw', 'insights.jsonl'));

// ---- render page ----
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (v) => (v === null || v === undefined ? '<span class="absent">absent</span>' : esc(v));
const dayRows = Object.entries(DATA.cyclesByDay).sort().map(([d, n]) => `<tr><td>${esc(d)}</td><td>${n}</td></tr>`).join('') || '<tr><td colspan="2" class="absent">no cycles logged yet</td></tr>';
const skillRows = (arr) => arr.length ? arr.map((s) => `<li>${esc(s)}</li>`).join('') : '<li class="absent">(none)</li>';
const outcomeRows = DATA.outcomes.length
  ? DATA.outcomes.slice(-60).reverse().map((o) => `<tr><td>${esc(o.time.slice(0, 10))}</td><td>${esc(o.name)}</td><td class="act-${esc(o.action)}">${esc(o.action)}</td><td>${esc(o.reason).slice(0, 160)}</td></tr>`).join('')
  : '<tr><td colspan="4" class="absent">no skill verdicts yet</td></tr>';
const paretoRows = DATA.paretoRejected.length
  ? DATA.paretoRejected.slice(-40).reverse().map((p) => `<tr><td>${esc(p.time.slice(0, 10))}</td><td>${esc(p.name)}</td><td>${esc(p.reason)}</td></tr>`).join('')
  : '<tr><td colspan="3" class="absent">no rejected candidates archived yet</td></tr>';
const insightRows = DATA.recentInsights.length
  ? DATA.recentInsights.map((i) => `<tr><td>${esc(i.time.slice(0, 10))}</td><td>${esc(i.text)}</td></tr>`).join('')
  : '<tr><td colspan="2" class="absent">no insights yet</td></tr>';

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>hmharness · 自进化证据(evidence)</title>
<style>
:root{--navy:#0B1E3A;--cyan:#4FD8EB;--text:#DCE8F2;--dim:#8FA8C0;--line:rgba(79,216,235,.22);--bg:#081527}
body{background:var(--bg);color:var(--text);font-family:"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;margin:0;line-height:1.65}
.wrap{max-width:1000px;margin:0 auto;padding:32px 24px}
a{color:var(--cyan)}h1{font-size:26px}h2{font-size:18px;color:var(--cyan);border-bottom:1px solid var(--line);padding-bottom:6px;margin-top:36px}
table{border-collapse:collapse;width:100%;font-size:13.5px}td,th{border:1px solid var(--line);padding:6px 10px;text-align:left}th{color:var(--dim);font-weight:600}
.absent{color:var(--dim);font-style:italic}
.act-promoted{color:#5dd39e}.act-rejected{color:#e0b34c}.act-error{color:#e05c5c}
.cards{display:flex;gap:14px;flex-wrap:wrap;margin:18px 0}
.card{background:rgba(13,32,58,.7);border:1px solid var(--line);border-radius:12px;padding:14px 18px;min-width:130px}
.card .v{font-size:26px;font-weight:700;color:var(--cyan)}.card .k{font-size:12px;color:var(--dim)}
.note{color:var(--dim);font-size:13px}code{background:rgba(79,216,235,.08);padding:1px 5px;border-radius:4px}
footer{margin-top:48px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:14px}
</style></head><body><div class="wrap">
<h1>hmharness 自进化证据</h1>
<p class="note">本页由 <code>scripts/export-evidence.cjs</code> 从 HMH_HOME 的真实日志生成,数字只来自文件,缺席标注为 absent。协议见 <a href="https://github.com/swsgbl/hmharness/blob/main/docs/SELFFEED.md">docs/SELFFEED.md</a>;原始数据在 <a href="raw/">raw/</a>。</p>
<div class="cards">
<div class="card"><div class="v">${num(DATA.cycles)}</div><div class="k">进化轮次</div></div>
<div class="card"><div class="v">${DATA.skills.active.length}</div><div class="k">active 技能</div></div>
<div class="card"><div class="v">${DATA.skills.canary.length}</div><div class="k">canary 试验中</div></div>
<div class="card"><div class="v">${DATA.skills.draft.length}</div><div class="k">draft 待门禁</div></div>
<div class="card"><div class="v">${DATA.skills.archive.length}</div><div class="k">archive 历史</div></div>
<div class="card"><div class="v">${num(DATA.insights)}</div><div class="k">洞察数</div></div>
<div class="card"><div class="v">${num(DATA.memoryNotes)}</div><div class="k">长期记忆条</div></div>
<div class="card"><div class="v">${num(DATA.benchCases)}</div><div class="k">bench 用例</div></div>
</div>
<p class="note">窗口:${num(DATA.firstCycle)} → ${num(DATA.lastCycle)} · 生成于 ${esc(DATA.generatedAt)}</p>
<p style="background:rgba(224,179,76,.12);border:1px solid rgba(224,179,76,.3);border-radius:8px;padding:10px 14px;font-size:13.5px;color:#e0b34c"><b>⚠ 外推性声明:</b>当前数据全部来自<b>自设任务</b>(scripts/selffeed-tasks.json,作者编写),bench 用例同源。进化系统在此人造适应度景观上的表现<b>不代表</b>其在真实外部开发者任务上的效果。外推性待第一批外部用户数据验证。</p>

<h2>每日进化轮次</h2>
<table><tr><th>日期</th><th>轮次</th></tr>${dayRows}</table>

<h2>技能判例(晋升/拒绝,含理由——诚实优先)</h2>
<table><tr><th>日期</th><th>技能</th><th>判定</th><th>理由</th></tr>${outcomeRows}</table>

<h2>被拒候选存档(Pareto 池)</h2>
<table><tr><th>日期</th><th>候选</th><th>拒因</th></tr>${paretoRows}</table>

<h2>最近洞察</h2>
<table><tr><th>日期</th><th>洞察</th></tr>${insightRows}</table>

<h2>技能清单</h2>
<p><b>active:</b></p><ul>${skillRows(DATA.skills.active)}</ul>
<p><b>canary:</b></p><ul>${skillRows(DATA.skills.canary)}</ul>
<p><b>draft:</b></p><ul>${skillRows(DATA.skills.draft)}</ul>

<footer>hmharness evidence page · self-evolution claims must be auditable · regenerate: <code>node scripts/export-evidence.cjs</code></footer>
</div>
<script type="application/json" id="raw-log">${rawLogEmbedded.replace(/<\/script/gi, '<\\/script')}</script>
</body></html>`;

fs.writeFileSync(path.join(OUT, 'index.html'), html, 'utf8');
console.log('evidence exported ->', path.join(OUT, 'index.html'));
console.log('  cycles:', DATA.cycles ?? 'absent', '| active:', DATA.skills.active.length,
  '| canary:', DATA.skills.canary.length, '| outcomes:', DATA.outcomes.length, '| pareto:', DATA.paretoRejected.length);
