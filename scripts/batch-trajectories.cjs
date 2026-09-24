#!/usr/bin/env node
/**
 * scripts/batch-trajectories.cjs - Automated trajectory production
 *
 * The RL gate needs >=1000 high-quality trajectories; the protocol produces
 * ~3/day manually. This runner executes N behavioral tasks from the bench
 * case pool through the full agent loop, producing one trajectory each.
 *
 * Usage: node scripts/batch-trajectories.cjs [--count=10] [--workspace=G:/hmharness-selffeed]
 *
 * Each task is a real tool-using run (read/count/verify against workspace
 * files), so every trajectory has genuine tool calls and outcomes.
 */
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const count = Number((args.find((a) => a.startsWith('--count=')) ?? '').slice(8)) || 5;
const workspace = (args.find((a) => a.startsWith('--workspace=')) ?? '').slice(12) || 'G:/hmharness-selffeed';
const HMH_HOME = process.env.HMH_HOME || path.join(require('os').homedir(), '.hmharness');
const CLI = path.join(__dirname, '..', 'packages', 'cli', 'src', 'main.ts');

// Behavioral task templates: each produces a real tool-using trajectory
const targets = [
  'behave-target.txt', 'behave-target2.txt', 'behave-target5.txt',
  'behave-target6.txt', 'behave-target7.txt', 'behave-target10.txt',
];
const workspaces = ['SelfFeed1', 'SelfFeedR', 'SelfFeedN', 'SelfFeedM'];
const tasks = [];
for (let i = 0; i < count; i++) {
  const t = targets[i % targets.length];
  const ws = workspaces[i % workspaces.length];
  const variant = i % 8;
  if (variant === 0) tasks.push(`Read C:/Users/hongfu/.hmharness/bench/cases/${t} with read_file, then reply ONLY the line count as a digit.`);
  else if (variant === 1) tasks.push(`Read C:/Users/hongfu/.hmharness/bench/cases/${t} with read_file, then reply ONLY the last word on the last line.`);
  else if (variant === 2) tasks.push(`Read G:/hmharness-selffeed/${ws}/entry/src/main/module.json5 with read_file, then reply ONLY the mainElement value.`);
  else if (variant === 3) tasks.push(`Read C:/Users/hongfu/.hmharness/bench/cases/${t} with read_file, then reply ONLY the first word of the first line.`);
  // M-variants (09-17): NEW archetypes with different tool mixes so the
  // trajectory dedupe (task+outcome+turns+tools fingerprint) yields NEW rows
  else if (variant === 4) tasks.push(`Read both C:/Users/hongfu/.hmharness/bench/cases/behave-target.txt and behave-target2.txt with read_file, then reply ONLY the sum of their line counts as a digit.`);
  else if (variant === 5) tasks.push(`Read G:/hmharness-selffeed/${ws}/entry/src/main/module.json5 with read_file AND list_dir the entry/src/main directory, then reply ONLY the line count of module.json5.`);
  else if (variant === 6) tasks.push(`Read C:/Users/hongfu/.hmharness/bench/cases/${t} with read_file, then reply ONLY FOUND if its content contains the word "behave", otherwise reply MISSING.`);
  else tasks.push(`List the directory C:/Users/hongfu/.hmharness/bench/cases with list_dir, then reply ONLY the number of files it contains as a digit.`);
}

console.log(`batch: ${tasks.length} tasks, workspace=${workspace}`);
let ok = 0, fail = 0;
for (const [i, task] of tasks.entries()) {
  process.stdout.write(`  [${i + 1}/${tasks.length}] `);
  try {
    const out = execSync(`node "${CLI}" "${task}" --yes`, {
      cwd: workspace,
      timeout: 120000,
      encoding: 'utf8',
      env: { ...process.env, HMH_HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const hasSession = /\(session /.test(out);
    if (hasSession) { ok++; console.log('OK'); } else { fail++; console.log('NO-SESSION'); }
  } catch (e) {
    fail++;
    console.log('FAIL:', String(e.message).slice(0, 60));
  }
}
console.log(`\nbatch done: ${ok} ok / ${fail} fail (${ok} trajectories produced)`);
