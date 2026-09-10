/**
 * Provider preset contract smoke test (scripts/preset-smoke.cjs)
 * The /vN endpoint bug existed from 0.1.0 to 0.3.0 undetected - unit tests
 * were green because they tested code paths, not the actual preset DATA
 * (baseUrl/auth scheme/model name). This script makes one minimal API call
 * per configured provider to verify the full chain: endpoint reachable +
 * auth accepted + model responds. Run in CI or as a daily cron.
 *
 * Exit code: 0 = all presets pass, 1 = any fail (CI gate).
 * Providers are read from HMH_HOME config.json - only configured ones are
 * tested (a preset without an API key is a config gap, not a code bug).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.HMH_HOME || path.join(os.homedir(), '.hmharness');
const cfg = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
const providers = Object.entries(cfg.providers ?? {});

if (providers.length === 0) {
  console.log('no providers configured - nothing to smoke test');
  process.exit(0);
}

let failures = 0;

async function smokeOne(name, p) {
  const url = p.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(p.authHeader ? { [p.authHeader]: p.apiKey } : { Authorization: `Bearer ${p.apiKey}` }),
      },
      body: JSON.stringify({
        model: p.model,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const ms = Date.now() - t0;
    if (res.status === 401 && !p.authHeader) {
      // retry with X-Api-Key (the kernel's auto-renegotiation)
      const res2 = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': p.apiKey },
        body: JSON.stringify({ model: p.model, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], max_tokens: 5 }),
        signal: AbortSignal.timeout(30000),
      });
      if (res2.ok) { console.log(`  ✓ ${name.padEnd(14)} ${ms + (Date.now() - t0 - ms)}ms (X-Api-Key)`); return; }
      console.log(`  ✗ ${name.padEnd(14)} HTTP ${res.status}/${res2.status} - auth rejected both schemes`);
      failures++;
      return;
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 120);
      console.log(`  ✗ ${name.padEnd(14)} HTTP ${res.status} ${body}`);
      failures++;
      return;
    }
    const j = await res.json();
    const reply = (j.choices?.[0]?.message?.content ?? '').trim().slice(0, 30);
    console.log(`  ✓ ${name.padEnd(14)} ${Date.now() - t0}ms → "${reply}"`);
  } catch (e) {
    console.log(`  ✗ ${name.padEnd(14)} ${e.name}: ${String(e.message).slice(0, 80)}`);
    failures++;
  }
}

(async () => {
  console.log(`provider preset smoke test (${providers.length} configured):\n`);
  // sequential: parallel calls would trip rate limits (tokenrouter 8/min)
  for (const [name, p] of providers) {
    await smokeOne(name, p);
  }
  console.log(failures === 0 ? '\nALL PRESETS PASS' : `\n${failures} PRESET(S) FAILED`);
  process.exit(failures > 0 ? 1 : 0);
})();
