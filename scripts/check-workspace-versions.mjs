import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const expected = rootPkg.version;
const failures = [];
const packageRoot = join(root, 'packages');

for (const name of readdirSync(packageRoot)) {
  const file = join(packageRoot, name, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    continue;
  }
  if (typeof pkg.name !== 'string' || !pkg.name.startsWith('@hmharness/')) continue;
  if (pkg.version !== expected) {
    failures.push(`${file}: version ${pkg.version} != root ${expected}`);
  }
  for (const [dependency, version] of Object.entries(pkg.dependencies ?? {})) {
    if (!dependency.startsWith('@hmharness/')) continue;
    if (version !== expected) {
      failures.push(`${file}: ${dependency}=${version} != root ${expected}`);
    }
  }
}

if (failures.length) {
  console.error('Workspace version contract FAILED:');
  for (const failure of failures) console.error(' - ' + failure);
  console.error('Fix internal package versions and dependencies before build/release.');
  process.exit(1);
}
console.log(`Workspace version contract PASS: all internal packages and dependencies are ${expected}`);
