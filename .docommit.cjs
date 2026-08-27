const fs = require('fs');
const GIT = 'C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise\\Common7\\IDE\\CommonExtensions\\Microsoft\\TeamFoundation\\Team Explorer\\Git\\cmd\\git.exe';
const { execSync } = require('child_process');
const cwd = 'G:/hmharness';
function g(args) { return execSync('"' + GIT + '" ' + args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
try { g('add -A'); } catch (e) { console.log('add fail', e.message); process.exit(1); }
const msg = [
  'feat(ui): dsh-inspired redesign - three-column web, dsh-style TUI line types',
  '',
  'web (layout modeled on the deepseek-harness web app, zero-dep vanilla):',
  '- three-column grid: sidebar (brand=new session, new-session button,',
  '  session search, session tree with task titles + running dots, footer',
  '  skills/model) | main (chip topbar, chat flow, composer) | details',
  '  column (click a tool row -> full args + output, closable)',
  '- composer: input card with focus ring, approval-mode dropdown replacing',
  '  the checkbox (ask / auto-approve), token chip, send; approvals take',
  '  over the composer area with a pulsing amber card (dsh pattern)',
  '- tool rows are clickable cards with status dots (running/ok/error) and',
  '  gutter-folded result previews; user messages are bubbles with the',
  '  dsh prompt glyph; stats line per turn incl. token arrows',
  '- back-to-bottom floating button; sidebar sessions carry task titles',
  '  (server joins insights); server broadcasts full tool output (8k) for',
  '  the details panel',
  '',
  'tui (line types modeled on dsh-tui):',
  "- user bubbles (prompt glyph), 'therefore' Thinking prefix, tool cards",
  '  with colored status dots and result-gutter previews, per-task token',
  "  footer, one-line status above the prompt, '?' alias for /help",
  '',
  'kernel: Session.append now serializes through a write chain - the',
  'constructor fire-and-forget session/start could land AFTER the first',
  'awaited event (audit order race, caught by the test suite; 5x stress',
  'pass)',
].join('\n');
fs.writeFileSync('G:/hmharness/.commit-msg.txt', msg);
g('commit -F .commit-msg.txt');
fs.unlinkSync('G:/hmharness/.commit-msg.txt');
console.log(g('log --oneline -1'));
try { g('push -q origin main'); console.log('pushed'); } catch (e) { console.log('push failed - network'); }
