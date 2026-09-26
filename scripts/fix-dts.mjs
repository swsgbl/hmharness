// fix-dts.mjs — rewrite relative .ts specifiers in emitted .d.ts to .js
// (TS rewriteRelativeImportExtensions rewrites emitted JS but leaves .ts
//  specifiers in declaration files, which consumers with
//  allowImportingTsExtensions:false cannot resolve.)
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const pkgsDir = path.join(root, 'packages');
let touched = 0;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.name.endsWith('.d.ts')) continue;
    const src = fs.readFileSync(p, 'utf8');
    const out = src
      .replace(/(from\s+')(\.[^']*?)\.ts'/g, '$1$2.js\'')
      .replace(/(from\s+")(\.[^"]*?)\.ts"/g, '$1$2.js"');
    if (out !== src) { fs.writeFileSync(p, out); touched++; }
  }
}
for (const e of fs.readdirSync(pkgsDir, { withFileTypes: true })) {
  if (!e.isDirectory()) continue;
  const dist = path.join(pkgsDir, e.name, 'dist');
  if (fs.existsSync(dist)) walk(dist);
}
console.log('[fix-dts] rewrote', touched, 'declaration files');
