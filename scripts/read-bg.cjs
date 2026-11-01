// read the background task stdout log (script file)
const fs = require('fs');
const p = 'C:/Users/hongfu/AppData/Local/Temp/zcode-bash-Dme2Xk/sess_6da1a3c4-1d72-426f-aef5-76a17f5ccfa8/call_faa086656431438ba337f107-stdout.log';
try {
  const s = fs.readFileSync(p, 'utf8');
  console.log('LEN:', s.length);
  console.log(s.slice(0, 2000));
} catch (e) { console.log('read fail:', String(e).slice(0, 80)); }
