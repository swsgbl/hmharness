/**
 * web_fetch must say WHY a fetch failed (2026-11-26).
 *
 * Of 19 web_fetch failures on record, 11 said only "fetch failed: TypeError:
 * fetch failed": sites this network reaches only through a proxy. Node keeps
 * the reason in `cause`; the model was never shown it, so it could not tell an
 * unreachable host from a slow one. The shapes here are the ones Node actually
 * produces (taken from a probe on the machine the failures were recorded on).
 *
 * The tools are imported as a namespace so that, against a build without this,
 * the tests fail on what the tool DID rather than on a missing export.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import * as tools from '../tools.ts';

const describe = (): ((err: unknown) => string) => {
  const fn = (tools as Record<string, unknown>).describeFetchError;
  assert.equal(typeof fn, 'function', 'the tools module has a fetch-error describer');
  return fn as (err: unknown) => string;
};
// the wrapper Node puts around every network-level failure
const wrapped = (cause: unknown): unknown => Object.assign(new TypeError('fetch failed'), { cause });

test('the reason hidden in cause is named, and what it means is said', () => {
  const d = describe();
  const refused = d(wrapped(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:52858'), { code: 'ECONNREFUSED' })));
  assert.match(refused, /^fetch failed: ECONNREFUSED connect ECONNREFUSED 127\.0\.0\.1:52858/);
  assert.match(refused, /connection refused or reset/);
  // the shape of the 11 recorded failures
  const reset = d(wrapped(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })));
  assert.match(reset, /ECONNRESET read ECONNRESET/);
  assert.match(reset, /proxy or a mirror may be needed/);
  const unresolved = d(wrapped(Object.assign(new Error('getaddrinfo ENOTFOUND no-such-host.invalid'), { code: 'ENOTFOUND' })));
  assert.match(unresolved, /ENOTFOUND getaddrinfo ENOTFOUND no-such-host\.invalid/);
  assert.match(unresolved, /host name not resolved from this network/);
  const slow = d(wrapped(Object.assign(new Error('Connect Timeout Error (attempted addresses: 1.2.3.4:443, timeout: 10000ms)'), { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' })));
  assert.match(slow, /UND_ERR_CONNECT_TIMEOUT Connect Timeout Error/);
  assert.match(slow, /no answer within the time limit/);
  const cert = d(wrapped(Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })));
  assert.match(cert, /UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
  assert.match(cert, /TLS or certificate problem/);
  // the output cap still hit: undici's abort surfaces as a named error without a code
  const aborted = d(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
  assert.match(aborted, /TimeoutError: The operation was aborted due to timeout/);
  assert.match(aborted, /no answer within the time limit/);
});

test('the bare wrapper is never repeated, and an error without a cause is not lost', () => {
  const d = describe();
  // only "TypeError: fetch failed", no cause: still bounded and still honest about what is known
  const bare = d(new TypeError('fetch failed'));
  assert.ok(bare.startsWith('fetch failed: '), bare);
  assert.ok(!bare.includes('fetch failed <- '), bare);
  const other = d(new Error('boom'));
  assert.equal(other, 'fetch failed: Error: boom');
  // nothing runs away: a long chain is cut
  const long = d(wrapped(Object.assign(new Error('x'.repeat(500)), { code: 'ECONNRESET' })));
  assert.ok(long.length < 420, String(long.length));
});

test('web_fetch against a closed local port reports the connection, not "fetch failed"', async () => {
  const tool = tools.webFetchTool;
  assert.ok(tool, 'web_fetch exists');
  // a port that was listening a moment ago and is closed now: nothing to reach, no network needed
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const out = await tool.execute({ url: `http://127.0.0.1:${port}/` }, { cwd: '.', home: '.' } as never);
  assert.equal(out.isError, true);
  assert.match(out.output, /^fetch failed: ECONNREFUSED connect ECONNREFUSED 127\.0\.0\.1:\d+/);
  assert.match(out.output, /connection refused or reset/);
});
