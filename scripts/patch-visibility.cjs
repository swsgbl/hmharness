// 1) brain: step BEFORE the LLM call + BEFORE the proactive read
// 2) serve: mirror step lines to the daemon stdout (operator parity)
const fs = require('fs');

const brain = 'G:/hmharness/packages/cli/src/extension-chat.ts';
let s = fs.readFileSync(brain, 'utf8');
let n = 0;
function rep(p, from, to) {
  if (!s.includes(from)) { console.log('ANCHOR MISSING in', p, ':', JSON.stringify(from.slice(0, 50))); process.exit(1); }
  s = s.replace(from, to); n++;
}
rep(brain,
  '  const t0 = Date.now();\n  const step = (line: string) => { try { deps.step?.(line); } catch { /* feed is best-effort */ } };',
  '  const t0 = Date.now();\n  const step = (line: string) => { try { deps.step?.(line); } catch { /* feed is best-effort */ } };\n  step(\'读取当前页面(预热)…\');',
);
rep(brain,
  "    if (outOfTime) step('已达单段时限,收尾汇报…');\n    const res = await chatImpl(",
  "    if (outOfTime) step('已达单段时限,收尾汇报…');\n    step(`第 ${round + 1} 轮思考中…(已用 ${Math.round((Date.now() - t0) / 1000)}s)`);\n    const res = await chatImpl(",
);
fs.writeFileSync(brain, s);
console.log('brain patched', n);

const main = 'G:/hmharness/packages/cli/src/main.ts';
let m = fs.readFileSync(main, 'utf8');
const from = "        // round 50: every step streams to the panel's live activity view\n        step: (l) => bridge.noteChatActivity(input.origin ?? 'anon', l),";
const to = "        // round 50: every step streams to the panel's live activity view\n        // AND the daemon log (operator sees what the user sees)\n        step: (l) => { bridge.noteChatActivity(input.origin ?? 'anon', l); stdout.write(`  ${DIM('· ' + l)}\\n`); },";
if (!m.includes(from)) { console.log('ANCHOR MISSING in main.ts'); process.exit(1); }
m = m.replace(from, to);
fs.writeFileSync(main, m);
console.log('main patched');
