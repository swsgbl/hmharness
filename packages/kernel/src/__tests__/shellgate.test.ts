import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBareProbe } from '../shellgate.ts';
import { parseRetryAfterMs } from '../provider.ts';

test('isBareProbe: plain read-only probes are fast-pathed', () => {
  for (const ok of ['df -h', 'ps aux', 'uptime', 'cat /etc/hosts', 'ls -la /var/log', 'grep -c error app.log', 'free -m', 'wc -l notes.txt', 'id', 'pwd']) {
    assert.equal(isBareProbe(ok), true, ok);
  }
});

test('isBareProbe: every documented bypass class is blocked (audit payloads)', () => {
  const blocked = [
    'find /tmp -delete',                    // argument-level execution (GHSA-cv3g-hj65-pcfh)
    'find . -exec rm {} \\;',               // find -exec
    'echo $(touch /x)',                     // command substitution (cli-mcp-server 0.2.5)
    'echo `touch /x`',                      // backtick substitution
    'echo hi >& /etc/file',                 // fd-dup redirect (old regex whitelisted >&)
    'echo hi > /etc/file',                  // plain redirect
    'date -s 2030-01-01',                   // clock set via allowlisted verb
    'ls /; rm -rf /',                       // chaining
    'ls / && rm x',                         // chaining
    'cat /etc/passwd | sh',                 // pipe into executor
    'rm -rf /tmp/x',                        // destructive verb outright
    'systemctl restart nginx',              // mutating verb
    'xargs rm',                             // exec-in-args verb
    'awk "system(\\"rm x\\")"',             // exec-in-args verb
    '',                                     // empty
  ];
  for (const bad of blocked) {
    assert.equal(isBareProbe(bad), false, JSON.stringify(bad));
  }
});

test('parseRetryAfterMs: legal forms parsed, epoch garbage and overflow clamped', () => {
  assert.equal(parseRetryAfterMs('30'), 30_000);                 // delta-seconds
  assert.equal(parseRetryAfterMs('100000'), 120_000);            // clamped to max
  assert.equal(parseRetryAfterMs(null), 0);
  assert.equal(parseRetryAfterMs('not-a-date'), 0);
  assert.equal(parseRetryAfterMs('1789105094'), 120_000);        // epoch-seconds string -> clamped, never 1.7e12
  const httpDate = new Date(Date.now() + 5_000).toUTCString();
  const d = parseRetryAfterMs(httpDate);
  assert.ok(d > 3_000 && d <= 5_000, `http-date within range: ${d}`);
  const past = new Date(Date.now() - 60_000).toUTCString();
  assert.equal(parseRetryAfterMs(past), 0);                      // past date -> 0 (fallback backoff)
});
