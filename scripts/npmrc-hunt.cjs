// find the broken npmrc line that injects flag --e
const fs = require('fs');
const candidates = [
  'G:/hmharness/.npmrc',
  'C:/Users/hongfu/.npmrc',
  'C:/Users/hongfu/AppData/Roaming/npm/etc/npmrc',
];
for (const f of candidates) {
  try {
    const s = fs.readFileSync(f, 'utf8');
    const bad = s.split('\n').filter((l) => /^\s*(e\b|--e)/i.test(l));
    console.log(f, bad.length ? 'BAD LINES: ' + JSON.stringify(bad) : '(clean)');
  } catch { console.log(f, '(absent)'); }
}
// env vars npm reads: npm_config_e*
for (const [k, v] of Object.entries(process.env)) {
  if (/^npm_config_e/i.test(k)) console.log('ENV:', k, '=', v);
}
