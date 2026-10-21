// ARC3 exploration batch: uncertainty-seeking engine plays N games (zero
// vision/LLM cost — only ARC API quota). Corpus diversity fuel: the policy
// probes poorly-known action types instead of repeating known ones.
const { execSync } = require('child_process');
const GAMES = Number(process.env.ARC3_GAMES ?? 10);
const ACTIONS = Number(process.env.ARC3_ACTIONS ?? 30);
let ok = 0;
let fail = 0;
for (let i = 1; i <= GAMES; i++) {
  console.log(`\n=== explore ${i}/${GAMES} (actions=${ACTIONS}) @ ${new Date().toISOString()} ===`);
  try {
    const out = execSync(`npx tsx packages/cli/src/main.ts cognitive explore --env=arc3 --actions=${ACTIONS}`, {
      cwd: 'G:/hmharness',
      encoding: 'utf8',
      timeout: 10 * 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines = out.split('\n').filter((l) => /探索完成|轨迹|置信/.test(l));
    console.log(lines.slice(0, 3).join('\n'));
    ok++;
  } catch (e) {
    fail++;
    const tail = (String(e.stdout || '') + String(e.stderr || '')).split('\n').filter(Boolean).slice(-3).join('\n');
    console.log('EXPLORE FAILED:\n' + tail);
    if (/E_NO_API_KEY|quota|limit|401|403/i.test(tail)) { console.log('>> quota signal — stopping'); break; }
  }
}
console.log(`\nEXPLORE BATCH DONE: ${ok} ok, ${fail} failed`);
