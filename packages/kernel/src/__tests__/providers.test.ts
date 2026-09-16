import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProviders, resolveProvider } from '../types.ts';
import { endpoint } from '../provider.ts';
import { homeDir, loadConfig, setChatRoute, defaultConfig, upsertProvider, deleteProvider } from '../config.ts';

test('endpoint: any /vN suffix is complete; bare bases get /v1 appended', () => {
  assert.equal(endpoint('https://api.x.com/v1'), 'https://api.x.com/v1/chat/completions');
  // zhipu coding plan ends in /v4 - the old endsWith('/v1') check appended
  // /v1/chat/completions onto it (HTTP 404 in the wild)
  assert.equal(endpoint('https://open.bigmodel.cn/api/coding/paas/v4'), 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions');
  assert.equal(endpoint('https://ark.cn-beijing.volces.com/api/v3'), 'https://ark.cn-beijing.volces.com/api/v3/chat/completions');
  assert.equal(endpoint('https://api.x.com'), 'https://api.x.com/v1/chat/completions');
  assert.equal(endpoint('https://api.x.com/v1/'), 'https://api.x.com/v1/chat/completions', 'trailing slash trimmed');
});

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

test('upsertProvider: insert, replace-with-key-preservation, validation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-upsert-'));
  const prev = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  try {
    // insert
    await upsertProvider({ name: 'myapi', baseUrl: 'https://myapi.example/v1/', model: 'm1', apiKey: 'sk-one' });
    let raw = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
    assert.equal(raw.providers.myapi.baseUrl, 'https://myapi.example/v1', 'trailing slash trimmed');
    assert.equal(raw.providers.myapi.model, 'm1');
    assert.equal(raw.providers.myapi.apiKey, 'sk-one');
    // update model + baseUrl WITHOUT apiKey -> key preserved (no secret round-trip)
    await upsertProvider({ name: 'myapi', baseUrl: 'https://myapi.example/v2', model: 'm2' });
    raw = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
    assert.equal(raw.providers.myapi.model, 'm2');
    assert.equal(raw.providers.myapi.apiKey, 'sk-one', 'empty apiKey must keep the existing key');
    // explicit new key replaces
    await upsertProvider({ name: 'myapi', baseUrl: 'https://myapi.example/v2', model: 'm2', apiKey: 'sk-two' });
    raw = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
    assert.equal(raw.providers.myapi.apiKey, 'sk-two');
    // validation
    await assert.rejects(() => upsertProvider({ name: 'bad name!', baseUrl: 'https://x/v1', model: 'm' }), /provider name/);
    await assert.rejects(() => upsertProvider({ name: 'ok', baseUrl: 'not-a-url', model: 'm' }), /baseUrl/);
    await assert.rejects(() => upsertProvider({ name: 'ok', baseUrl: 'https://x/v1', model: '  ' }), /model/);
  } finally {
    if (prev === undefined) delete process.env.HMH_HOME;
    else process.env.HMH_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});

test('deleteProvider: removes a provider and clears routing keys that point at it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hmh-del-'));
  const prev = process.env.HMH_HOME;
  process.env.HMH_HOME = home;
  try {
    await upsertProvider({ name: 'keep', baseUrl: 'https://keep/v1', model: 'k' });
    await upsertProvider({ name: 'drop', baseUrl: 'https://drop/v1', model: 'd' });
    await setChatRoute('keep');
    // deleting the ACTIVE route clears routing.chat instead of refusing
    const cfg = await deleteProvider('keep');
    assert.equal(cfg.providers?.keep, undefined);
    assert.equal(cfg.routing?.chat, undefined, 'routing.chat cleared with its provider');
    assert.equal(cfg.providers?.drop?.model, 'd');
    // non-active deletes cleanly, config otherwise untouched
    await deleteProvider('drop');
    assert.equal((await loadConfig()).providers?.drop, undefined);
    await assert.rejects(() => deleteProvider('nope'), /unknown provider/);
  } finally {
    if (prev === undefined) delete process.env.HMH_HOME;
    else process.env.HMH_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});
