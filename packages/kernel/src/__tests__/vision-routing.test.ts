/**
 * Vision routing regression tests.
 *
 * Background (a real false negative, 2026-09-11): `routing.vision` named a
 * text-only provider (@quality/omnifusion). It shadowed the `vision` block,
 * every screenshot went to a blind model, the model answered HTTP 200 with
 * "I can't view the image", and harmony_ui_regression reported FAIL - none
 * of [Hello HarmonyOS] visible. The app was rendering perfectly the whole
 * time; the device view tree proved it.
 *
 * These tests pin the two guards that make that impossible:
 *   1. resolveProvider('vision') skips a provider marked supportsVision:false
 *   2. isVisionRefusal() identifies a blind answer so callers never grade it
 *      as evidence about the image
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../config.ts';
import { isVisionRefusal, foundLineText, foundNothing, resolveProvider, visionProviderChain, listProviders } from '../types.ts';

const P = (model: string, extra: Record<string, unknown> = {}) => ({
  baseUrl: `https://${model}.example/v1`,
  apiKey: 'k',
  model,
  ...extra,
});

test('vision: routing.vision pointing at a text-only provider does not shadow the vision block', () => {
  const cfg = {
    ...defaultConfig(),
    provider: P('chat-default'),
    providers: {
      blind: P('text-only-model', { supportsVision: false }),
      seer: P('vision-model'),
    },
    routing: { chat: 'blind', vision: 'blind' },
    vision: P('vision-model'),
  };
  // chat still uses the routed provider (that is fine - text is its job)
  assert.equal(resolveProvider(cfg, 'chat').model, 'text-only-model');
  // vision must NOT: the marked-blind provider is skipped
  assert.equal(resolveProvider(cfg, 'vision').model, 'vision-model');
});

test('vision: an unmarked routing.vision provider still wins (no silent behaviour change)', () => {
  const cfg = {
    ...defaultConfig(),
    providers: { v: P('routed-vision'), other: P('other-vision') },
    routing: { chat: 'other', vision: 'v' },
    vision: P('other-vision'),
  };
  assert.equal(resolveProvider(cfg, 'vision').model, 'routed-vision');
});

test('vision: without routing, the vision block wins; without that, the chat default', () => {
  const withBlock = { ...defaultConfig(), provider: P('chat'), vision: P('block-vision'), providers: {} };
  assert.equal(resolveProvider(withBlock, 'vision').model, 'block-vision');
  const bare = { ...defaultConfig(), provider: P('chat-only') };
  assert.equal(resolveProvider(bare, 'vision').model, 'chat-only');
});

test('visionProviderChain: orders routing -> vision -> fallbacks, drops blank bases and duplicates, filters blind', () => {
  const cfg = {
    ...defaultConfig(),
    provider: P('chat-default'),
    providers: { routed: P('routed', { supportsVision: false }), seer: P('seer') },
    routing: { chat: 'routed', vision: 'routed' },
    vision: P('seer'), // duplicate of providers.seer -> collapses
    visionFallbacks: [P('fb1'), { baseUrl: '', apiKey: 'k', model: 'blank' }, P('fb2', { supportsVision: false })],
  };
  assert.deepEqual(visionProviderChain(cfg).map((p) => p.model), ['seer', 'fb1', 'chat-default']);
});

test('visionProviderChain: all-blind config still returns candidates (fail loudly, not "unconfigured")', () => {
  const cfg = {
    ...defaultConfig(),
    provider: P('chat-default', { supportsVision: false }),
    providers: { blind: P('blind', { supportsVision: false }) },
    routing: { chat: 'blind', vision: 'blind' },
  };
  assert.deepEqual(visionProviderChain(cfg).map((p) => p.model), ['blind', 'chat-default']);
});

test('listProviders: a text-only provider is not advertised as serving vision', () => {
  const cfg = {
    ...defaultConfig(),
    providers: { blind: P('text-only', { supportsVision: false }), seer: P('vision') },
    routing: { chat: 'blind', vision: 'blind' },
  };
  const rows = listProviders(cfg);
  assert.deepEqual(rows.find((r) => r.name === 'blind')?.purposes, ['chat', 'evolve', 'bench']);
  assert.deepEqual(rows.find((r) => r.name === 'seer')?.purposes, []);
});

test('isVisionRefusal: catches the exact blind-provider answer, in both languages', () => {
  const refusals = [
    "I can't view the image, so I can't describe the device screen or read any UI text.",
    'I cannot see the image. Please provide an image.',
    "I'm not able to view images.",
    'I am unable to see the attached image.',
    'No image was provided in this request.',
    "I don't have the ability to view images.",
    'As an AI language model, I cannot view images.',
    "I'm sorry, but I can't access the screenshot you mentioned.",
    '作为一个人工智能，我无法查看图片。',
    '我无法看到你提供的图像。',
    '抱歉，我不能识别图片内容。',
  ];
  for (const r of refusals) assert.equal(isVisionRefusal(r), true, `should be a refusal: ${r}`);
});

test('isVisionRefusal: catches the live-observed @quality phrasing (real evidence, 2026-09-11)', () => {
  // exact answer from the local text-only endpoint when handed a screenshot
  const live = 'The device screen cannot be described because the provided image is unsupported or unavailable.\nFOUND: No readable UI text';
  assert.equal(isVisionRefusal(live), true);
  assert.equal(isVisionRefusal('The provided image is unavailable, so I cannot help.'), true);
  assert.equal(isVisionRefusal('Sorry, the screenshot is unsupported in this request.'), true);
  assert.equal(isVisionRefusal('I am unable to describe the image you sent.'), true);
  // and the FOUND-line tell, which that same answer carries
  assert.equal(foundLineText(live), 'No readable UI text');
  assert.equal(foundNothing(live), true);
  assert.equal(foundNothing('FOUND: Hello HarmonyOS'), false);
  assert.equal(foundNothing('FOUND: none'), true);
  assert.equal(foundNothing('a screen with no FOUND line at all'), false);
});

test('isVisionRefusal: a real screen description is NOT a refusal', () => {
  const ok = [
    "The image shows a mobile device screen with a plain white background. The center features large bold text that reads 'Hello HarmonyOS'. FOUND: Hello HarmonyOS",
    'A screenshot of a phone app listing three products with prices.',
    'The device screen shows a settings list with the words System, Display, Battery.',
  ];
  for (const t of ok) assert.equal(isVisionRefusal(t), false, `should NOT be a refusal: ${t}`);
  assert.equal(isVisionRefusal(''), false);
});
