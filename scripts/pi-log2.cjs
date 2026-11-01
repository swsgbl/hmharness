// pi session logs — walk subdirectories too
const fs = require('fs');
const path = require('path');
const dir = 'C:/Users/hongfu/.pi/agent/sessions';
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else if (/\.jsonl$/.test(e.name)) files.push({ f, m: fs.statSync(f).mtimeMs });
  }
})(dir);
files.sort((a, b) => b.m - a.m);
const latest = files.slice(0, 2);
for (const { f } of latest) {
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
  console.log('== ' + f + ' (' + lines.length + ' lines) ==');
  const interesting = [];
  for (const l of lines) {
    if (/act_ui|继续|find_roots|observe_ui/.test(l)) interesting.push(l.slice(0, 300));
  }
  console.log(interesting.slice(-12).join('\n---\n').slice(0, 2500) || '(no UIA activity lines matched)');
}
