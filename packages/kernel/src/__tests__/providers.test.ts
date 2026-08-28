import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProviders, resolveProvider } from '../types.ts';
import { homeDir, loadConfig, setChatRoute, defaultConfig } from '../config.ts';

test('listProviders marks purposes and falls back to a single default row', () => {
  const cfg = {
    ...defaultConfig(),
    providers: {
      a: { baseUrl: 'https://a/v1', apiKey: '', model: 'big' },
      v: { baseUrl: 'https://b/v1', apiKey: '', model: 'vision-x' },
      c: { baseUrl: 'https://c/v1', apiKey: '', model: 'small' },
    },
    routing: { chat: 'a', vision: 'v', bench: 'c' },
  };
  const rows = listProviders(cfg);
  assert.deepEqual(rows.find((r) => r.name === 'a')?.purposes, ['chat', 'evolve']);
  assert.deepEqual(rows.find((r) => r.name === 'v')?.purposes, ['vision']);
  assert.deepEqual(rows.find((r) => r.name === 'c')?.purposes, ['bench']);
  // no providers block -> single default row serving everything
  const single = listProviders(defaultConfig());
  assert.equal(single.length, 1);
  assert.equal(single[0].name, 'default');
  assert.deepEqual(single[0].purposes, ['chat', 'vision', 'evolve', 'bench']);
});

test('setChatRoute persists routing.chat, keeps other fields, rejects unknown names', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-model-'));
  const prev = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  try {
    await writeFile(join(home, 'config.json'), JSON.stringify({
      provider: { baseUrl: 'https://main/v1', apiKey: 'sk-keep', model: 'main-model' },
      providers: {
        main: { baseUrl: 'https://main/v1', apiKey: 'sk-keep', model: 'main-model' },
        alt: { baseUrl: 'https://alt/v1', apiKey: 'sk-alt', model: 'alt-model' },
      },
      maxTurns: 11,
      mcpServers: { demo: { type: 'http', url: 'https://mcp/v1', trusted: true } },
      locale: 'en',
    }), 'utf8');
    const cfg = await setChatRoute('alt');
    assert.equal(resolveProvider(cfg, 'chat').model, 'alt-model');
    // evolve/bench inherit chat's route
    assert.equal(resolveProvider(cfg, 'evolve').model, 'alt-model');
    const raw = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
    assert.equal(raw.routing?.chat, 'alt');
    assert.equal(raw.maxTurns, 11);
    assert.equal(raw.mcpServers?.demo?.url, 'https://mcp/v1');
    assert.equal(raw.locale, 'en');
    assert.equal(raw.provider?.apiKey, 'sk-keep');
    // unknown provider -> error, config untouched
    await assert.rejects(() => setChatRoute('nope'), /unknown provider/);
    assert.equal(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')).routing?.chat, 'alt');
    // loadConfig still honours HMH_LOCALE on top
    process.env.HMH_LOCALE = 'zh';
    assert.equal((await loadConfig()).locale, 'zh');
    delete process.env.HMH_LOCALE;
  } finally {
    if (prev === undefined) delete process.env.HMH_HOME;
    else process.env.HMH_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});

// keep homeDir referenced so the import stays meaningful in all environments
void homeDir;
