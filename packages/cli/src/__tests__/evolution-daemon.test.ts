import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { daemonRunnerSource } from '../evolution-daemon.ts';

test('daemon runner is valid plain CJS (0.14.25 regression: top-level await + ESM import in .cjs died instantly)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hmh-daemon-'));
  try {
    const src = daemonRunnerSource('evolution-daemon.pid', 'G:\\abs\\path\\to\\main.js');
    // the runner must parse as CJS - node --check exits non-zero on syntax error
    const p = join(dir, 'runner.cjs');
    writeFileSync(p, src, 'utf8');
    execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' });
    assert.ok(/hmhEntry = "G:\\\\abs\\\\path\\\\to\\\\main\.js"/.test(src), 'entry path baked in verbatim');
    assert.ok(!/^\s*import\s/m.test(src), 'no ESM import statements');
    assert.ok(!/await\s+import\(/.test(src), 'no top-level await');
    // the two cycles are scheduled: evolve first, then the finetune gate
    assert.ok(src.includes("'evolve'") && src.includes("'auto-finetune', '--submit'"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
