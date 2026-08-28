// temp: audit hardcoded Chinese per package (code lines, not comments)
const fs = require('fs');
const pkgs = ['kernel', 'evolution', 'domain-harmony', 'domain-ops', 'agent', 'cli', 'web'];
for (const p of pkgs) {
  const dir = 'packages/' + p + '/src';
  let files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const fp = d + '/' + f;
      try {
        if (fs.statSync(fp).isDirectory()) walk(fp);
        else if (f.endsWith('.ts') && !fp.includes('__tests__') && !f.endsWith('.test.ts')) files.push(fp);
      } catch (e) {}
    }
  })(dir);
  let cn = 0;
  const cnFiles = [];
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    const hits = s.split('\n').filter((l) => /[\u4e00-\u9fff]/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l) && !/^\s*\*/.test(l));
    if (hits.length) {
      cn += hits.length;
      cnFiles.push(f.replace('packages/' + p + '/src/', '') + ':' + hits.length);
    }
  }
  console.log(p.padEnd(16), ('code-cn-lines: ' + cn).padEnd(18), cnFiles.slice(0, 10).join(' '));
}
