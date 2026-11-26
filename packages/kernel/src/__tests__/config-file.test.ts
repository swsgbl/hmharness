/**
 * config.json is the file that holds every provider key. Two ways to lose it,
 * both met on 2026-11-26 in a real session: a UTF-8 BOM in front of the file
 * (PowerShell 5.1 `Out-File -Encoding UTF8` writes one) made `loadConfig` fall
 * back to an EMPTY config without a word - "19 个 provider 都没了" - and every
 * settings action then read the broken file as `{}` and wrote the empty object
 * back over it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, setLocale, patchConfig, setChatRoute, setConfigWarningSinkForTests } from '../config.ts';

const BOM = '\uFEFF';
const FULL = {
  locale: 'zh',
  provider: { baseUrl: 'http://a', apiKey: 'k', model: 'm' },
  providers: { main: { baseUrl: 'http://a', apiKey: 'secret-key', model: 'm' } },
  routing: { chat: 'main' },
};

async function withHome<T>(config: string | null, fn: (home: string, file: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'hmh-cfg-'));
  const prev = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  const file = join(home, 'config.json');
  try {
    if (config !== null) await writeFile(file, config, 'utf8');
    return await fn(home, file);
  } finally {
    if (prev === undefined) delete process.env.HMH_HOME; else process.env.HMH_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

test('a config with a UTF-8 BOM loads whole', async () => {
  await withHome(BOM + JSON.stringify(FULL, null, 2), async () => {
    const cfg = await loadConfig();
    assert.equal(cfg.locale, 'zh');
    assert.ok(cfg.providers?.main, 'the provider table survived');
    assert.equal(cfg.providers!.main!.apiKey, 'secret-key');
    assert.equal(cfg.provider.model, 'm', 'the legacy provider is derived from the routed one');
  });
});

test('a config that cannot be parsed falls back to the defaults - and says so, once, without touching the file', async () => {
  const broken = '{ "providers": { "main": '; // truncated
  const lines: string[] = [];
  setConfigWarningSinkForTests((line) => lines.push(line));
  try {
    await withHome(broken, async (_home, file) => {
      const cfg = await loadConfig();
      assert.equal(cfg.providers, undefined, 'defaults');
      assert.equal(lines.length, 1, 'one warning');
      assert.ok(/config\.json/.test(lines[0]!) && /无法解析/.test(lines[0]!), `it names the file and the problem: ${lines[0]}`);
      assert.match(lines[0]!, /默认配置/, 'and that the defaults are in use');
      assert.equal(await readFile(file, 'utf8'), broken, 'the file is left exactly as it was');
      await loadConfig();
      assert.equal(lines.length, 1, 'said once per process, not on every load');
    });
  } finally { setConfigWarningSinkForTests(null); }
});

test('a settings change on a BOM-prefixed config keeps every provider', async () => {
  await withHome(BOM + JSON.stringify(FULL, null, 2), async (_home, file) => {
    await setLocale('en');
    const after = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) as typeof FULL;
    assert.equal(after.locale, 'en');
    assert.equal(after.providers.main.apiKey, 'secret-key', 'the key is still there');
    assert.equal(after.routing.chat, 'main');
  });
});

test('a settings change on an unparseable config is refused: the file is never replaced by a near-empty one', async () => {
  const broken = BOM + '{ "providers": { "main": "x" } },,,';
  for (const act of [
    () => setLocale('en'),
    () => patchConfig({ locale: 'en' }),
    () => setChatRoute('main'),
  ]) {
    await withHome(broken, async (_home, file) => {
      await assert.rejects(act(), /无法解析|cannot be parsed|unknown provider/, 'the change is refused with the reason');
      assert.equal(await readFile(file, 'utf8'), broken, 'byte for byte unchanged');
    });
  }
});

test('with no config yet, a settings change creates one', async () => {
  await withHome(null, async (_home, file) => {
    await setLocale('en');
    const after = JSON.parse(await readFile(file, 'utf8')) as { locale?: string };
    assert.equal(after.locale, 'en');
  });
});
