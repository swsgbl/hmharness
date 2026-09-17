/** Remove *.v2bak leftovers from every package's dist/ before build/publish
 *  (the write-lock bypass renames produce them; they must never ship in the
 *  npm tarball - evolution 0.14.9 shipped a batch of harmless-but-ugly
 *  copies because this cleanup didn't exist). */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const pkgs = path.join(root, 'packages');
let removed = 0;
for (const d of fs.readdirSync(pkgs)) {
  const dir = path.join(pkgs, d, 'dist');
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.includes('.v2bak')) continue;
    fs.rmSync(path.join(dir, f), { force: true });
    removed++;
    console.log('removed', d, f);
  }
}
console.log('clean-dist:', removed, 'stale file(s) removed');
