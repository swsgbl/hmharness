// debug test 5 flow
const { autoUpdate, checkForUpdate } = await import('./packages/cli/src/update-check.ts');
const { mkdtemp, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const home = await mkdtemp(join(tmpdir(), 'dbg-upd-'));
const fetchImpl = (async () => new Response(JSON.stringify({ latest: '9.9.9' }), { status: 200 })) as unknown as typeof fetch;
await checkForUpdate({ home, current: '0.1.0', fetchImpl });
const spawned = [];
const said = []; const failed = [];
await autoUpdate({
  home, current: '0.1.0', now: Date.now(),
  say: (l) => said.push(l),
  sayFail: (l) => failed.push(l),
  spawnImpl: (file, args) => {
    spawned.push({ file, args: args.join(' ').slice(0, 60) });
    const first = spawned.length === 1;
    return { unref: () => {}, on: (ev, fn) => { if (first && ev === 'error') setImmediate(fn); } };
  },
  aiChat: async () => '{"command":"npm install -g @hmharness/cli@9.9.9"}',
});
console.log('spawned:', JSON.stringify(spawned));
console.log('said:', said, 'failed:', failed);
await rm(home, { recursive: true, force: true });
