import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProviderAuthError } from '../provider.ts';

test('provider-auth: permanent 401/402/403 auth failures are detected', () => {
  // the exact strings the provider retry chain throws after exhausting attempts
  assert.equal(isProviderAuthError('provider: failed after 6 attempts (https://api.example.com/v4): HTTP 401 (unauthorized): {"error":"invalid api key"}'), true);
  assert.equal(isProviderAuthError('provider: failed after 6 attempts (https://api.example.com/v4): HTTP 402 (payment required): balance exhausted'), true);
  assert.equal(isProviderAuthError('provider: failed after 2 attempts (https://api.example.com/v4): HTTP 403 (forbidden)'), true);
});

test('provider-auth: transient and unrelated failures stay undetected (queue keeps draining)', () => {
  // 429 rate limits reset on their own; 5xx are server-side hiccups; network
  // errors retry — none of these justify holding the task queue
  assert.equal(isProviderAuthError('provider: failed after 6 attempts: HTTP 429 (rate limited): limit resets at 16:06'), false);
  assert.equal(isProviderAuthError('provider: failed after 6 attempts: HTTP 500 (internal server error)'), false);
  assert.equal(isProviderAuthError('provider: fetch failed: TypeError: connect ETIMEDOUT'), false);
  assert.equal(isProviderAuthError('HTTP 4010 (custom code)'), false); // no word boundary
  assert.equal(isProviderAuthError(''), false);
  assert.equal(isProviderAuthError('totally unrelated error'), false);
});
