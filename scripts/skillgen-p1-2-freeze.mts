/** P1-2 setup: freeze corpus fingerprint (read-only) into the manifest basis. */
import { loadTrajectories } from '../packages/cognitive/src/index.ts';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.HMH_HOME ?? join(homedir(), '.hmharness');
const all = await loadTrajectories(HOME, 2000);
const FAMS = ['terminal', 'harmonyos', 'browser'];
const famInfo: Record<string, { total: number; succ: number; ids: string[] }> = {};
for (const f of FAMS) {
  const ts = all.filter((t) => t.environment.id === f && t.steps.length > 0);
  famInfo[f] = {
    total: ts.length,
    succ: ts.filter((t) => t.metrics.success).length,
    ids: ts.map((t) => t.id).sort(),
  };
}
const canonical = FAMS.map((f) => `${f}:${famInfo[f]!.ids.join(',')}`).join('\n');
const datasetHash = createHash('sha256').update(canonical).digest('hex');
console.log(JSON.stringify({
  datasetHash,
  families: Object.fromEntries(FAMS.map((f) => [f, { total: famInfo[f]!.total, succ: famInfo[f]!.succ, n: famInfo[f]!.ids.length }])),
}, null, 2));
