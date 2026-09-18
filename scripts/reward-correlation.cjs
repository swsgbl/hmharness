/** Reward-calibration report (RL era, post-gate): join the 122+ HUMAN star
 *  labels with the AUTOMATIC reward proxy (rewardFor mapping over insight
 *  outcomes) for the same sessions, and compute how well the auto signal
 *  tracks human judgment. Re-runnable — the correlation tightens as labels
 *  accumulate; it is the baseline any reward-model work must beat. */
const fs = require('fs');
const path = require('path');
const home = 'C:/Users/hongfu/.hmharness';

function readJsonl(f) {
  try {
    return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

(async () => {
  const labels = readJsonl(path.join(home, 'evolution', 'reward-human-labels.jsonl'));
  const insights = readJsonl(path.join(home, 'insights', 'insights.jsonl'));
  const bySession = new Map();
  for (const i of insights) if (!bySession.has(i.session)) bySession.set(i.session, i);

  const rows = [];
  for (const l of labels) {
    const ins = bySession.get(l.session);
    if (!ins) continue;
    const outcome = ins.outcome === 'ok' ? 'ok' : (ins.outcome === 'turn-budget' ? 'turn-budget' : 'error');
    // auto reward proxy per rewardFor(outcome, 0) - insights carry no fail rate
    const auto = outcome === 'ok' ? 1.0 : outcome === 'turn-budget' ? 0.5 : 0.3;
    rows.push({ session: l.session, human: l.score / 5, humanStars: l.score, auto, outcome });
  }
  const n = rows.length;
  const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  const H = rows.map((r) => r.human);
  const A = rows.map((r) => r.auto);
  const mh = mean(H), ma = mean(A);
  let cov = 0, vh = 0, va = 0;
  for (let i = 0; i < n; i++) { cov += (H[i] - mh) * (A[i] - ma); vh += (H[i] - mh) ** 2; va += (A[i] - ma) ** 2; }
  const pearson = vh && va ? cov / Math.sqrt(vh * va) : 0;
  // Spearman (rank) — robust for the coarse 3-bucket auto signal
  const rank = (arr) => { const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const r = new Array(arr.length); idx.forEach(([v, i], k) => { r[i] = k + 1; }); return r; };
  const rh = rank(H), ra = rank(A);
  const mh2 = mean(rh), ma2 = mean(ra);
  let c2 = 0, v2h = 0, v2a = 0;
  for (let i = 0; i < n; i++) { c2 += (rh[i] - mh2) * (ra[i] - ma2); v2h += (rh[i] - mh2) ** 2; v2a += (ra[i] - ma2) ** 2; }
  const spearman = v2h && v2a ? c2 / Math.sqrt(v2h * v2a) : 0;

  // the calibration insight: human spread WITHIN the auto 'ok' bucket —
  // humans see quality differences the outcome-based reward cannot
  const okRows = rows.filter((r) => r.auto === 1.0);
  const okHuman = okRows.map((r) => r.humanStars);

  const report = {
    at: new Date().toISOString(),
    n,
    pearson: Number(pearson.toFixed(3)),
    spearman: Number(spearman.toFixed(3)),
    humanMean: Number(mh.toFixed(3)),
    autoBuckets: {
      ok: rows.filter((r) => r.auto === 1).length,
      turn_budget: rows.filter((r) => r.auto === 0.5).length,
      error: rows.filter((r) => r.auto === 0.3).length,
    },
    okBucketHumanStars: {
      n: okHuman.length,
      mean: okHuman.length ? Number(mean(okHuman).toFixed(2)) : null,
      min: okHuman.length ? Math.min(...okHuman) : null,
      max: okHuman.length ? Math.max(...okHuman) : null,
    },
    verdict: '',
  };
  report.verdict = n < 30
    ? 'needs-data (<30 joined samples)'
    : Math.abs(spearman) >= 0.5
      ? 'auto reward tracks human judgment moderately — usable as RL base signal, refine with human deltas'
      : 'auto reward is COARSE vs human judgment — the human labels carry the real signal; a reward model trained on these labels is the next lever';

  fs.mkdirSync(path.join(home, 'ops'), { recursive: true });
  fs.writeFileSync(path.join(home, 'ops', 'reward-calibration.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(report, null, 2));
})();
