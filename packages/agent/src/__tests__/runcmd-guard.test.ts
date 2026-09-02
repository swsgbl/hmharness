import test from 'node:test';
import assert from 'node:assert/strict';
import { unixPipeOnWindows } from '../tools.ts';

test('unixPipeOnWindows refuses Unix pipelines with cmd equivalents', () => {
  const r1 = unixPipeOnWindows('curl -s http://x | head -100', 'win32');
  assert.ok(r1 && r1.includes('head') && r1.includes('more'));
  assert.ok(unixPipeOnWindows('cat /app/dist/index.js | grep -i api', 'win32')?.includes('type file')); // first host segment wins
  // Unix words INSIDE a container command are legal; only the host tail is flagged
  const dr = unixPipeOnWindows('docker exec c ls /app | tail -5', 'win32');
  assert.ok(dr && dr.includes('tail') && dr.includes('Get-Content'));
  assert.ok(unixPipeOnWindows('which node', 'win32')?.includes('where'));
  // legit commands pass untouched
  assert.equal(unixPipeOnWindows('netstat -ano | findstr LISTENING', 'win32'), null);
  assert.equal(unixPipeOnWindows('dir /b C:\\tools', 'win32'), null);
  assert.equal(unixPipeOnWindows('npm run build', 'win32'), null);
  // non-Windows hosts never trip the guard
  assert.equal(unixPipeOnWindows('cat x | grep y | head', 'linux'), null);
  // words inside filenames/args must not false-positive (e.g. 'ls.exe' ok? 'catalog')
  assert.equal(unixPipeOnWindows('echo catalog lattice', 'win32'), null);
});

test('failed-command short-circuit: third identical failure is refused without execution', async () => {
  // use a command guaranteed to fail on this host, invoked through the tool
  const { runCommandTool } = await import('../tools.ts');
  const ctx = { cwd: process.cwd(), home: process.env.HMH_HOME ?? 'C:/nonexistent-home' };
  const bad = 'exit /b 1';
  const r1 = await runCommandTool.execute({ command: bad }, ctx);
  const r2 = await runCommandTool.execute({ command: bad }, ctx);
  assert.equal(r1.isError, true);
  assert.equal(r2.isError, true);
  const r3 = await runCommandTool.execute({ command: bad }, ctx);
  assert.equal(r3.isError, true);
  assert.match(r3.output, /already failed 2 times/);
});
