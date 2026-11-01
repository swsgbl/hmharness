// probe the licenses endpoint response shape
import fs from 'node:fs';
import crypto from 'node:crypto';
const CREDS = JSON.parse(fs.readFileSync('G:/hmharness/.audit/amo-creds.json', 'utf8'));
const b = (buf) => Buffer.from(buf).toString('base64url');
const h = b(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const p = b(JSON.stringify({ iss: CREDS.issuer, jti: crypto.randomBytes(16).toString('hex'), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 }));
const jwt = `${h}.${p}.${crypto.createHmac('sha256', CREDS.secret).update(h + '.' + p).digest('base64url')}`;
const r = await fetch('https://addons.mozilla.org/api/v5/licenses/', { headers: { Authorization: `JWT ${jwt}` } });
console.log('status:', r.status);
const t = await r.text();
console.log('body head:', t.slice(0, 700));
