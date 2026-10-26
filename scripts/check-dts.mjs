/** 查 kernel dist 声明。 */
import { readFileSync, existsSync } from 'node:fs';
const p = 'packages/kernel/dist/provider.d.ts';
if (!existsSync(p)) { console.log('no provider.d.ts;list:'); }
else {
  const d = readFileSync(p, 'utf8');
  console.log('signal in dist dts:', d.includes('signal'));
  const i = d.indexOf('ChatOptions');
  console.log(d.slice(i, i + 180));
}
import { readdirSync } from 'node:fs';
console.log('kernel dist files:', readdirSync('packages/kernel/dist').slice(0, 12).join(', '));
