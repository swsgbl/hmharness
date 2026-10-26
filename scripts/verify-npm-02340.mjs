/** 验证 16 包 npm 版本。 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const pkgs = ['kernel','observability','evaluation','sandbox','cognitive','environments','browser','extension','evolution','domain-harmony','domain-ops','lsp','agent','web','cli','codexhost-bridge'];
let ok = 0; const bad = [];
for (const p of pkgs) {
  try {
    const v = execSync(`npm view @hmharness/${p} version --registry https://registry.npmjs.org`, { encoding: 'utf8', timeout: 30_000 }).trim();
    if (v === '0.23.40') ok += 1; else bad.push(`${p}:${v}`);
  } catch { bad.push(`${p}:ERR`); }
}
const report = `npm 0.23.40: ${ok}/${pkgs.length}` + (bad.length ? ` BAD: ${bad.join(',')}` : ' ALL OK');
writeFileSync('G:/hmharness/.npm-verify.txt', report, 'utf8');
console.log('written');
