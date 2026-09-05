import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDeclaration, buildApiIndex, lookupSymbol } from '../apikg.ts';
import { sendNotification } from '@hmh/domain-ops';

/* ---------------- d.ts parser shapes ---------------- */

test('parser: export default class / declare namespace / members all index', () => {
  const text = [
    '/**',
    ' * @kit AbilityKit',
    ' */',
    'export default class Want {',
    '  bundleName?: string;',
    '  action?: string;',
    '  static fromJson(json: string): Want;',
    '}',
    '',
    'declare namespace hilog {',
    '    function info(domain: number, tag: string, format: string, ...args: any[]): void;',
    '    const DEBUG: number;',
    '}',
    '',
    'export enum Color {',
    '    RED = 0,',
    '}',
  ].join('\n');
  const out = parseDeclaration('fake.d.ts', '@ohos.fake', text);
  const names = out.map(([n]) => n);
  assert.ok(names.includes('Want'), 'default class indexed');
  assert.ok(names.includes('Want.fromJson'), 'static method indexed');
  assert.ok(names.includes('Want.action'), 'property indexed');
  assert.ok(names.includes('hilog'), 'namespace indexed');
  assert.ok(names.includes('hilog.info'), 'namespace function indexed');
  assert.ok(names.includes('hilog.DEBUG'), 'namespace const indexed');
  assert.ok(names.includes('Color'), 'enum indexed');
  const want = out.find(([n]) => n === 'Want')![1];
  assert.equal(want.kit, 'AbilityKit');
  assert.equal(want.module, '@ohos.fake');
});

/* ---------------- lookup over a tiny index ---------------- */

test('lookup: exact hit, fuzzy similar, fake symbol honestly rejected', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-apikg2-'));
  const api = join(home, 'sdk', 'default', 'openharmony', 'ets', 'api');
  await mkdir(api, { recursive: true });
  await writeFile(join(api, '@ohos.demo.d.ts'), '/**\n * @kit DemoKit\n */\nexport class Widget {\n  paint(x: number): void;\n}\n', 'utf8');
  const cache = join(home, 'kg');
  const idx = await buildApiIndex(home, cache);
  assert.ok(idx.symbolCount >= 2);
  const hit = lookupSymbol(idx, 'Widget');
  assert.equal(hit.exact.length, 1);
  assert.equal(hit.exact[0].kit, 'DemoKit');
  const fuzzy = lookupSymbol(idx, 'Widg');
  assert.ok(fuzzy.fuzzy.some((f) => f.name === 'Widget'));
  const fake = lookupSymbol(idx, 'NotReal');
  assert.equal(fake.exact.length, 0);
  assert.equal(fake.fuzzy.length, 0);
  // cache hit on second load (same mtime)
  const again = await buildApiIndex(home, cache);
  assert.equal(again.builtAt, idx.builtAt);
  await rm(home, { recursive: true, force: true });
});

/* ---------------- channel notifier ---------------- */

test('channel: unconfigured channel returns the exact config hint; configured channel posts (json webhook stub)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-chan-'));
  const miss = await sendNotification(home, 'team', 'build done');
  assert.equal(miss.ok, false);
  assert.match(miss.detail, /channel "team" not configured/);
  assert.match(miss.detail, /channels/);
  // configure a generic json webhook pointing at a local stub server
  let received = '';
  const srv = (await import('node:http')).createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { received = body; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"errcode":0}'); });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  await writeFile(join(home, 'config.json'), JSON.stringify({ channels: { team: { type: 'json', url: `http://127.0.0.1:${port}/hook` } } }), 'utf8');
  const ok = await sendNotification(home, 'team', 'build succeeded');
  assert.equal(ok.ok, true);
  assert.match(received, /build succeeded/);
  await new Promise<void>((r) => srv.close(() => r()));
  await rm(home, { recursive: true, force: true });
});
