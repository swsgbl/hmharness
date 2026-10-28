// memory entry for round 58 (script file: multiline safety)
const fs = require('fs');
const p = 'C:/Users/hongfu/.zcode/cli/memories/projects/hmharness-753ac60028695054/memory/hmharness-project-status.md';
let s = fs.readFileSync(p, 'utf8');
if (s.includes('round 58 当场验证')) { console.log('memory already present'); process.exit(0); }
const entry = `hmharness(G:\\hmharness)——**round 58 当场验证轮+Brave 终局(2026-10-28)**:用户三连质问"验证过吗/没见开浏览器/找不到扩展"→全改当场真机验证。快改:246 个 .lnk 勘查,10 个 Chromium 系快捷方式统一补 --load-extension→extension-live-2;Firefox 走 HKCU 策略(Program Files 需管理员);attach 取证常驻化。**Brave 终局:location-8 幽灵注册钉死旧目录+该注册下 storage 拒写→announce 每 30s 成功但 token 存不进→attach 永不执行=死循环**(node 冒充证明桥 SSE 全通);junction 方案回滚;**定案=Brave 转手动开发者模式装载**(一次即永久,扩展页已代开)。**教训:验证必须区分临时实例自动化 vs 用户日常档案真人;自动通道死地用手动一次是正解非妥协;诊断 beacon 设计时就常驻**。

`;
const idx = s.indexOf('hmharness(G:');
if (idx < 0) { console.log('anchor missing'); process.exit(1); }
s = s.slice(0, idx) + entry + s.slice(idx);
fs.writeFileSync(p, s);
console.log('memory round 58 inserted');
