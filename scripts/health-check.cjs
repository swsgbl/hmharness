// deployment consistency: source vs extension-live-2 vs bridge behavior
const fs = require('fs');
const SRC = 'G:/hmharness/packages/extension/extension';
const LIVE = 'C:/Users/hongfu/.hmharness/extension-live-2/chromium';
let problems = 0;

// 1) payload files byte-identical
for (const f of fs.readdirSync(SRC)) {
  const a = fs.readFileSync(SRC + '/' + f);
  const b = fs.readFileSync(LIVE + '/' + f);
  if (!a.equals(b)) { console.log('DIFF:', f); problems++; }
}
const mv = JSON.parse(fs.readFileSync(LIVE + '/manifest.json', 'utf8'));
console.log('live manifest v' + mv.version, '| sidePanel perm:', mv.permissions.includes('sidePanel'), '| popup:', mv.action?.default_popup ?? 'none');

// 2) bridge health + protocol + activity fallback
(async () => {
  try {
    const st = await (await fetch('http://127.0.0.1:7789/v1/status', { signal: AbortSignal.timeout(1500) })).json();
    console.log('bridge:', st.ok ? 'up' : 'down', '| connected:', st.connected, '| ext v' + st.extVersion);
    if (st.extVersion !== mv.version) { console.log('VERSION MISMATCH: daemon payload differs from deployed payload'); problems++; }
    const pf = await fetch('http://127.0.0.1:7789/v1/chat/activity', { method: 'OPTIONS', headers: { origin: 'chrome-extension://lceccbmgohpgfgckenddombndnklbafm', 'access-control-request-method': 'GET' } });
    console.log('preflight:', pf.status === 204 ? 'ok' : 'FAIL ' + pf.status);
    if (pf.status !== 204) problems++;
    const daemonPid = fs.readFileSync('C:/Users/hongfu/.hmharness/extension.pid', 'utf8').trim();
    let alive = 'dead';
    try { process.kill(Number(daemonPid), 0); alive = 'alive'; } catch { /* */ }
    console.log('daemon pid', daemonPid, alive);
  } catch (e) { console.log('bridge probe FAIL:', String(e).slice(0, 100)); problems++; }
  console.log(problems === 0 ? 'HEALTH: CONSISTENT' : 'HEALTH: ' + problems + ' problem(s)');
})();
