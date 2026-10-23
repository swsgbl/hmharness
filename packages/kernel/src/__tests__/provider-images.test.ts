/**
 * provider-images tests (2026-10-22, default-multimodal policy): a user
 * message carrying `images` becomes OpenAI image_url content parts on the
 * wire (the multimodal chat model sees the actual image); messages without
 * images are byte-identical to before (no regression); chatSeesImages
 * defaults to TRUE and only an explicit supportsVision:false opts out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chat } from '../provider.ts';
import { chatSeesImages } from '../types.ts';

async function withCaptureServer(): Promise<{ url: string; bodies: Array<Record<string, unknown>>; close: () => Promise<void> }> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    bodies,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

const fakeProvider: { name: string; baseUrl: string; apiKey: string; model: string } = { name: 'mm', baseUrl: '', apiKey: 'k', model: 'm' };

test('chat: a user message with images becomes image_url parts on the wire', async () => {
  const srv = await withCaptureServer();
  try {
    await chat(
      { ...fakeProvider, baseUrl: srv.url },
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'look at this', images: ['data:image/png;base64,AAA', 'data:image/png;base64,BBB'] },
      ],
    );
    const wire = srv.bodies[0]!.messages as Array<{ role: string; content: unknown }>;
    assert.equal(wire.length, 2);
    assert.equal(wire[0].content, 'sys', 'system message untouched');
    const parts = wire[1].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    assert.equal(parts.length, 3, 'text part + two image parts');
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[0].text, 'look at this');
    assert.equal(parts[1].type, 'image_url');
    assert.equal(parts[1].image_url!.url, 'data:image/png;base64,AAA');
    assert.equal(parts[2].image_url!.url, 'data:image/png;base64,BBB');
    assert.equal(JSON.stringify(wire[1]).includes('"images"'), false, 'the internal images field never leaks to the wire');
  } finally {
    await srv.close();
  }
});

test('chat: messages WITHOUT images keep the plain string content (no regression)', async () => {
  const srv = await withCaptureServer();
  try {
    await chat(
      { ...fakeProvider, baseUrl: srv.url },
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'plain text task' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] },
        { role: 'tool', content: 'result', tool_call_id: 'c1' },
      ],
    );
    const wire = srv.bodies[0]!.messages as Array<{ role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string }>;
    assert.equal(wire[1].content, 'plain text task');
    assert.ok(Array.isArray(wire[2].tool_calls), 'assistant tool_calls preserved on the wire');
    assert.equal(wire[3].tool_call_id, 'c1', 'tool message tool_call_id preserved');
  } finally {
    await srv.close();
  }
});

test('chat: a user message with images AND null content sends image parts only', async () => {
  const srv = await withCaptureServer();
  try {
    await chat(
      { ...fakeProvider, baseUrl: srv.url },
      [{ role: 'user', content: null, images: ['data:image/png;base64,QQ'] }],
    );
    const wire = srv.bodies[0]!.messages as Array<{ content: unknown }>;
    const parts = wire[0].content as Array<{ type: string }>;
    assert.equal(parts.length, 1, 'no empty text part when content is null');
    assert.equal(parts[0].type, 'image_url');
  } finally {
    await srv.close();
  }
});

test('chatSeesImages: default TRUE (multimodal by default); only explicit opt-out is text-only', () => {
  assert.equal(chatSeesImages({ baseUrl: 'x', apiKey: 'k', model: 'm' } as never), true, 'unmarked provider = multimodal');
  assert.equal(chatSeesImages({ baseUrl: 'x', apiKey: 'k', model: 'm', supportsVision: false } as never), false, 'explicit text-only');
  assert.equal(chatSeesImages({ baseUrl: 'x', apiKey: 'k', model: 'm', supportsVision: true } as never), true);
});
