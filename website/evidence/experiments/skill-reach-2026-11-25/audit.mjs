// 技能正文可达性审计(只读): 注入了技能的会话里, 有多少真的 read_file 过某个 SKILL.md?
//   node website/evidence/experiments/skill-reach-2026-11-25/audit.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const home = join(process.env.HMH_HOME ?? join(homedir(), '.hmharness'));
const insightsDir = join(home, 'insights');
const sessRoot = join(home, 'sessions');

// 1) 洞察记录: 哪些会话注入了技能(skillsInjected 非空)
const injected = new Map();   // session -> [skill names]
let insights = 0;
for (const f of readdirSync(insightsDir).filter((x) => x.endsWith('.jsonl'))) {
  for (const l of readFileSync(join(insightsDir, f), 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    insights++;
    const s = j.skillsInjected;
    if (Array.isArray(s) && s.length > 0 && j.session) injected.set(String(j.session), s);
  }
}
// 2) 会话转录: 该会话里有没有 read_file 过 SKILL.md
const files = [];
(function walk(d) { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl')) files.push(p); } })(sessRoot);
let withSession = 0, readSkill = 0, readAttempts = 0, refusedOrMissing = 0;
const examples = [];
for (const [sid, skills] of injected) {
  const f = files.find((p) => p.includes(sid));
  if (!f) continue;
  withSession++;
  let pending = [];
  let hit = false;
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.t === 'assistant' && Array.isArray(r.tool_calls)) {
      pending = r.tool_calls.map((c) => { let a = {}; try { a = JSON.parse(c.function?.arguments || '{}'); } catch { /* */ } return { name: c.function?.name, path: String(a.path ?? '') }; });
    } else if (r.t === 'tool' && r.name === 'read_file') {
      const c = pending.shift();
      if (c && /SKILL\.md/i.test(c.path)) {
        readAttempts++;
        if (r.isError) refusedOrMissing++; else hit = true;
        if (examples.length < 8) examples.push(`${sid.slice(-8)} ${r.isError ? 'ERR ' : 'ok  '}${c.path.slice(-70)}`);
      }
    }
  }
  if (hit) readSkill++;
}
console.log(`洞察记录 ${insights} 条; 注入了技能的会话 ${injected.size} 个, 其中能找到转录的 ${withSession} 个`);
console.log(`这些会话里, 真的读到过至少一个 SKILL.md 正文的: ${readSkill} 个 (${withSession ? (readSkill / withSession * 100).toFixed(1) : '-'}%)`);
console.log(`对 SKILL.md 的 read_file 调用共 ${readAttempts} 次, 其中报错/找不到 ${refusedOrMissing} 次`);
if (examples.length) { console.log('例子:'); for (const e of examples) console.log('  ' + e); }
