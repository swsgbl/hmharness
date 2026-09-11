/**
 * UI-regression honesty tests: a vision PROVIDER failure must never be
 * rendered as a product verdict.
 *
 * The failure that motivated this (2026-09-11): routing.vision pointed at a
 * text-only model, so the screenshot went to a blind provider, which replied
 * "I can't view the image". The tool asserted the expected keyword against
 * that refusal, found nothing, and reported `FAIL - none of [Hello HarmonyOS]
 * visible` - an app that was in fact rendering the text perfectly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { foundLineText, foundNothing } from '@hmharness/kernel';
import { describeWithChain, assertKeywords } from '../uiregress.ts';

const P = (model: string, extra: Record<string, unknown> = {}) => ({
  baseUrl: `https://${model}.example/v1`,
  apiKey: 'k',
  model,
  ...extra,
});

const PROMPT = 'describe the screen';
const IMAGE = 'data:image/jpeg;base64,AAAA';

test('describeWithChain: a blind provider is retried, not accepted as a description', async () => {
  const calls: string[] = [];
  const call = async (p: { model: string }) => {
    calls.push(p.model);
    if (p.model === 'text-only') return "I can't view the image, so I can't describe it.";
    return 'The screen shows large bold text reading Hello HarmonyOS.';
  };
  const { described, errors } = await describeWithChain([P('text-only'), P('seer')], PROMPT, IMAGE, call as never);
  assert.deepEqual(calls, ['text-only', 'seer'], 'the chain continues past a refusal');
  assert.match(String(described), /Hello HarmonyOS/);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /answered without seeing the image/);
});

test('describeWithChain: every provider blind -> described is null and the errors explain why', async () => {
  const call = async () => 'I cannot see the image. Please provide an image.';
  const { described, errors } = await describeWithChain([P('a'), P('b')], PROMPT, IMAGE, call as never);
  assert.equal(described, null);
  assert.equal(errors.length, 2);
  for (const e of errors) assert.match(e, /without seeing the image/);
});

test('describeWithChain: a throwing provider is skipped but a later real one still describes', async () => {
  const call = async (p: { model: string }) => {
    if (p.model === 'dead') throw new Error('HTTP 503: upstream down');
    return 'A white screen with the text Login.';
  };
  const { described, errors } = await describeWithChain([P('dead'), P('seer')], PROMPT, IMAGE, call as never);
  assert.match(String(described), /Login/);
  assert.match(errors[0], /HTTP 503/);
});

test('describeWithChain: a genuine description is returned on the first sighted provider', async () => {
  let n = 0;
  const call = async () => {
    n++;
    return 'The screen shows a list of three products.';
  };
  const { described, errors } = await describeWithChain([P('seer')], PROMPT, IMAGE, call as never);
  assert.equal(n, 1, 'no extra calls when the first provider can see');
  assert.match(String(described), /three products/);
  assert.deepEqual(errors, []);
});

test('assertKeywords: exact keyword hit only (case-insensitive), never "looks fine"', () => {
  const desc = "The image shows large bold text that reads 'Hello HarmonyOS'.";
  assert.equal(assertKeywords(desc, ['Hello HarmonyOS']), 'Hello HarmonyOS');
  assert.equal(assertKeywords(desc, ['hello harmonyos']), 'hello harmonyos');
  assert.equal(assertKeywords(desc, ['Login', 'HarmonyOS']), 'HarmonyOS', 'any hit wins');
  assert.equal(assertKeywords(desc, ['Login', 'Settings']), null);
});

test('a blind answer phrased as "no readable text" is treated as no-verdict, not a FAIL', async () => {
  // the exact live answer from the local text-only endpoint
  const blind = 'The device screen cannot be described because the provided image is unsupported or unavailable.\nFOUND: No readable UI text';
  const described = await describeWithChain([P('text-only')], PROMPT, IMAGE, (async () => blind) as never);
  assert.equal(described.described, null, 'a refusal is never returned as a description');
  assert.equal(described.errors.length, 1);
  // and if an UNMARKED provider returns it, the FOUND-line net still fires
  assert.equal(foundNothing(blind), true);
  assert.equal(foundLineText(blind), 'No readable UI text');
});
