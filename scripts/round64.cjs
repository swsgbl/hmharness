// devlog round 64 + memory: desktop contention — stop GUI automation, hand off
const fs = require('fs');
const dp = 'G:/hmharness/docs/DEVLOG.md';
let d = fs.readFileSync(dp, 'utf8');
if (d.includes('2026-10-31(六十四)')) { console.log('already present'); process.exit(0); }
const entry = `## 2026-10-31(六十四) · 桌面争抢止损:AMO listed 提交交接给用户

**动机**:继续 AMO listed 公开上架。向导推进到上传步骤(文件选择对话框由"真实鼠标 SendInput"打开——UIA Invoke 对网页文件选择器无效,Firefox 要求真实用户激活;ps1 全部需 UTF-8 BOM,否则中文正则乱码)。

**事故**:SendKeys 阶段与并行会话的 GUI 自动化(它正在驱动 KaihongOS 虚拟机里的 HMH Desktop)争抢前台——我的 SetForegroundWindow(firefox) 把它的 VM 前台抢走,它的自动化又把 ZCode/VM 抢回,我的 SendKeys 打进了它的会话窗口。截屏证实冲突后立即停止全部 GUI 自动化。

**已完成的部分**:上传 XPI 干净化(.amo-upload-uuid 删除——web-ext 签名时留的记账文件曾被打进 zip 导致 AMO 校验拒绝"Invalid file name in archive");干净 XPI 在 C:\\Users\\hongfu\\.hmharness\\.audit\\hmharness-listed-upload.xpi;Firefox 向导停在 upload-listed 步骤。

**交接**:剩余两步(上传文件+填元数据+提交)交用户手填,全部文案已备好(中英名称/摘要/描述/分类/标签/MIT 许可/审核说明)。多会话桌面上 GUI 自动化=与兄弟会话争抢输入,这类操作必须等桌面空闲或由人执行。

**教训**:①多个智能体会话共享一台桌面时,GUI 自动化互为干扰源——任何 SendKeys/click 前必须截屏确认前台身份,发现冲突立即停手;②Firefox 文件选择器需要真实用户激活(SendInput 鼠标可行,UIA Invoke 无效);③ps1 中文必须 UTF-8 BOM(node 写入后补 BOM)。
`;
const idx = d.indexOf('## 2026-10-31(六十三)');
if (idx < 0) { console.log('anchor missing'); process.exit(1); }
d = d.slice(0, idx) + entry + '\n\n---\n\n' + d.slice(idx);
fs.writeFileSync(dp, d);
console.log('devlog r64 inserted');
