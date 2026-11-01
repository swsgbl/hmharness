// poll npm for 0.23.49 (CI publish takes minutes) — also peek the GitHub CI via gh if available
const { execSync } = require('child_process');
(async () => {
  for (let i = 0; i < 20; i++) {
    try {
      const d = await (await fetch('https://registry.npmjs.org/@hmharness/cli/latest', { signal: AbortSignal.timeout(10000) })).json();
      if (d.version === '0.23.49') { console.log(`PUBLISHED ✓ @hmharness/cli@0.23.49 (after ${Math.round(i * 45 / 60 * 10) / 10} min wait)`); process.exit(0); }
      process.stdout.write(`poll ${i + 1}: latest=${d.version}\n`);
    } catch (e) { process.stdout.write(`poll ${i + 1}: registry unreachable\n`); }
    await new Promise((r) => setTimeout(r, 45000));
  }
  console.log('TIMEOUT: still not on npm after ~15 min — check CI: gh run list --limit 3');
  process.exit(1);
})();
