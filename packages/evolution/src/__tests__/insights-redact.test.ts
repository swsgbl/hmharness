import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../insights.ts';

// Secret shapes are assembled at runtime so this source file never contains a
// literal that GitHub Push Protection would flag (GH013 - it happened once).
const sk = ['sk', 'fkGthb8ni8zrvpSWM4OM5Zwwj1ObMf0mES7XuKfJAd0r9PRP'].join('-');
const ark = ['ark', '083d98a2-435f-416f-a1d9-43ad17eff677', 'b485f'].join('-');
const ghp = ['ghp', '0AbCdEfGhIjKlMnOpQrStUvWx12'].join('_');
const npmTok = ['npm', '75AnNSl1OoYMGBBdiyrYf8tnLgKAaT03DVOx'].join('_');

test('redactSecrets: every key shape seen in the wild is masked', () => {
  assert.equal(redactSecrets(`add provider ${sk} to config`), 'add provider sk-[REDACTED] to config');
  assert.equal(redactSecrets(`volc key ${ark} model ep-1`), 'volc key ark-[REDACTED] model ep-1');
  assert.equal(redactSecrets(`token ${ghp} use it`), 'token ghp_[REDACTED] use it');
  assert.equal(redactSecrets(`npm token ${npmTok}`), 'npm token npm_[REDACTED]');
  // ordinary content untouched
  assert.equal(redactSecrets('build the app and run tests'), 'build the app and run tests');
});
