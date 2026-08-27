// TUI live-task probe: pipe a task + /exit, print the dsh-style line types found
const { spawn } = require('child_process');
const fs = require('fs');
const child = spawn('node', ['packages/cli/dist/main.js', 'tui'], { cwd: 'G:/hmharness', shell: true });
let out = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { out += d.toString(); });
setTimeout(() => child.stdin.write('\u8fd0\u884c\u9e3f\u8499\u5de5\u5177\u94fe\u4f53\u68c0,\u4e00\u53e5\u8bdd\u603b\u7ed3\n'), 3000);
setTimeout(() => child.stdin.write('/exit\n'), 120000);
child.on('exit', () => {
  fs.writeFileSync('G:/hmharness/.tui-out.txt', out, 'utf8');
  const clean = out.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\[[sGKH]/g, '');
  const lines = clean.split('\n').filter((l) => /\u276F|\u2227|\u23BF|tok|Thinking|turns|OK \(/.test(l));
  console.log(lines.slice(0, 16).join('\n'));
  console.log('--- probe done');
});
