// Preloaded by `npm test`: every test process works in an HMH_HOME of its own.
//
// A test that never thought about the home used to work in the developer's REAL
// ~/.hmharness: on 2026-11-26 the real home held 22 run trajectories written by
// the suite ("run a harmless command", provider fake://) and a pile of empty
// session files - they showed up in the user's /resume list and fed the
// self-evolution feed with fake signals.
//
// A test that sets HMH_HOME itself (to a directory it made) is respected: this
// only supplies one when there is none.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.HMH_HOME) {
  const home = mkdtempSync(join(tmpdir(), 'hmh-test-home-'));
  process.env.HMH_HOME = home;
  process.on('exit', () => {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* a handle is still open: the OS temp cleaner gets it */ }
  });
}
