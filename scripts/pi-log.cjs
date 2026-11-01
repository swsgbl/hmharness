// read the latest pi session log — see what pi attempted
const fs = require('fs');
const dir = 'C:/Users/hongfu/.pi/agent/sessions';
const files = fs.readdirSync(dir).map((f) => ({ f, m: fs.statSync(dir + '/' + f).mtimeMs })).sort((a, b) => b.m - a.m).slice(0, 2);
for (const { f } of files) {
  const lines = fs.readFileSync(dir + '/' + f, 'utf8').trim().split('\n');
  console.log('== ' + f + ' (' + lines.length + ' lines) ==');
  // print the last tool calls + results
  const interesting = [];
  for (const l of lines) {
    try {
      const j = JSON.parse(l);
      const t = JSON.stringify(j);
      if (/act_ui|click|观察|继续|button|find_roots/.test(t)) interesting.push(t.slice(0, 250));
    } catch { /* skip */ }
  }
  console.log(interesting.slice(-10).join('\n').slice(0, 2200));
}
