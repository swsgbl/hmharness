/**
 * Device-lifecycle E2E: scaffold -> schema_check -> build -> install ->
 * launch -> logs -> uninstall against a connected device/emulator.
 * Run: npx tsx scripts/e2e-device.mts [target]
 * The emulator counts - hdc treats 127.0.0.1:5555 like any target.
 */
import { harmonyBuild, harmonyInstall, harmonyLaunch, harmonyLogs, harmonyUninstall, harmonySchemaCheck, scaffoldProject } from '../packages/domain-harmony/src/index.ts';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const target = process.argv[2] ?? '127.0.0.1:5555';
const root = join(tmpdir(), 'hmh-device-e2e', 'DevE2E');
const ctx = { cwd: root, home: join(homedir(), '.hmharness') };

const banner = (s: string) => console.log(`\n=== ${s} ===`);
const die = (step: string, out: string): never => {
  console.log(`[FAIL:${step}]\n${out.slice(0, 2000)}`);
  process.exit(1);
};

banner('scaffold');
const sc = await scaffoldProject(root, { name: 'DevE2E', bundleId: 'com.example.deve2e' });
console.log(`created ${sc.root} bundle=${sc.bundleId} files=${sc.files}`);

banner('schema check (pre-build gate)');
const s = await harmonySchemaCheck.execute({}, ctx);
console.log(s.output.slice(0, 400));
if (s.isError) die('schema', s.output);

banner('build');
const b = await harmonyBuild.execute({}, ctx);
console.log(b.output.split('\n').slice(0, 3).join('\n'));
if (b.isError) die('build', b.output);

banner(`install (target ${target})`);
const i = await harmonyInstall.execute({ target }, ctx);
console.log(i.output.slice(0, 600));
if (i.isError) die('install', i.output);

banner('launch');
const l = await harmonyLaunch.execute({ target }, ctx);
console.log(l.output.slice(0, 600));
if (l.isError) die('launch', l.output);

banner('logs (grep hmh tag)');
await new Promise((r) => setTimeout(r, 3000));
const g = await harmonyLogs.execute({ target, grep: 'hmh', lines: 20 }, ctx);
console.log(g.output.slice(0, 1500) || '(no matching lines)');

banner('uninstall (cleanup)');
const u = await harmonyUninstall.execute({ target, bundle: 'com.example.deve2e' }, ctx);
console.log(u.output.slice(0, 300));

console.log('\n=== DEVICE E2E COMPLETE ===');
