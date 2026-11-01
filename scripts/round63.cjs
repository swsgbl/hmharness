// devlog round 63 + README matrix update + memory: Firefox AMO signing done
const fs = require('fs');

// 1) README: Firefox row — persistent channel now open
const rp = 'G:/hmharness/packages/extension/README.md';
let r = fs.readFileSync(rp, 'utf8');
const rFrom = `### ② Firefox 特例 —— 同一份代码,XPI 装载(非通用通道)

- 当前(release 版):**about:debugging → 临时载入**(会话级,重启浏览器需重载;功能完整已实测——侧栏对话/读网页全通)
- 永久化:需 AMO 签名(计划中);企业策略 force_installed 对未签名 XPI 实测无效
- 装载后主机权限需在 about:addons 手动授予(结构性 opt-in)`;
const rTo = `### ② Firefox 特例 —— 同一份代码,签名 XPI 持久化(已开通)

- **签名版已发布**:XPI 经 Mozilla AMO unlisted 渠道自动签名(0.23.32 起);**企业策略 force_installed 持久安装已实测通过**(重启浏览器仍在)
- 用户侧:装一次永久;主机权限需在 about:addons 手动授予(结构性 opt-in)
- 历史:未签名 XPI 的策略安装与注册表通道均无效(实证);临时载入(about:debugging)仍是免签回退`;
if (r.includes(rFrom)) { r = r.replace(rFrom, rTo); fs.writeFileSync(rp, r); console.log('README firefox row updated'); }
else console.log('README firefox row: pattern differs, skip');

// 2) devlog round 63
const dp = 'G:/hmharness/docs/DEVLOG.md';
let d = fs.readFileSync(dp, 'utf8');
if (d.includes('2026-10-31(六十三)')) { console.log('devlog r63 already present'); }
else {
  const entry = `## 2026-10-31(六十三) · Firefox 持久化收口:AMO 签名发布(九浏览器全持久)

**动机**:用户"所有浏览器都持久化"并提供 AMO API 密钥(JWT issuer+secret,仅发布方需要一次)。

**链路**:web-ext sign --channel=unlisted → 首次提交被 AMO 校验拦下(**strict_min_version "121" 不合格式,须 "121.0";新扩展必填 data_collection_permissions**)→ 修 manifestFor firefox 源(adapters.ts,零数据收集声明)+ bump 0.23.32 → 重签自动核准 → 签名版 XPI 部署 → **HKCU 策略修正**:ExtensionSettings 键名必须用 gecko id(bridge@hmharness.dev,与 Chromium 固定 ID 不同!)→ Firefox 启动即 force-installed → 隔离 chat E2E PASS(AI 导航+读 "Example Domain")→ **重启持久化验证 PASS**。

**矩阵终态**:通用 Chromium 版(七台)+ Firefox 签名持久版 + BrowserOS ACP —— 九台浏览器全部持久化,全部真 chat 实测。

**教训**:①AMO 校验是清单规范的活文档(strict_min_version 格式、data_collection_permissions 新规)——提交前用 web-ext lint 可预检;②gecko id ≠ chromium id,策略键名按平台取 ID;③用户密钥只在会话内流转(命令行/临时文件用完即删),绝不入库。
`;
  const idx = d.indexOf('## 2026-10-31(六十二)');
  if (idx < 0) { console.log('devlog anchor missing'); process.exit(1); }
  d = d.slice(0, idx) + entry + '\n\n---\n\n' + d.slice(idx);
  fs.writeFileSync(dp, d);
  console.log('devlog r63 inserted');
}

// 3) memory
const mp = 'C:/Users/hongfu/.zcode/cli/memories/projects/hmharness-753ac60028695054/memory/hmharness-project-status.md';
let m = fs.readFileSync(mp, 'utf8');
if (!m.includes('round 63 Firefox AMO')) {
  const entry = `hmharness(G:\\hmharness)——**round 63 Firefox AMO 签名持久化收口(2026-10-31,九浏览器全持久)**:用户提供 AMO JWT 密钥(仅发布方一次)→ web-ext sign unlisted 自动签名;首次被 AMO 校验拦(strict_min_version 须 "121.0" 格式+新必填 data_collection_permissions)→修 adapters.ts firefox 清单源+bump 0.23.32→重签过;**HKCU 策略键名=gecko id(bridge@hmharness.dev)非 chromium 固定 ID**;签名版策略 force_installed 实测:启动即装+隔离 chat E2E PASS+重启持久化 PASS。矩阵终态:通用 Chromium 版七台+Firefox 签名持久+BrowserOS ACP=**九台全持久全实测**。**教训:AMO 校验是活文档,提交前 web-ext lint 预检;gecko id≠chromium id;用户密钥会话内流转不入库**。

`;
  const idx = m.indexOf('hmharness(G:');
  if (idx < 0) { console.log('memory anchor missing'); process.exit(1); }
  m = m.slice(0, idx) + entry + m.slice(idx);
  fs.writeFileSync(mp, m);
  console.log('memory r63 inserted');
} else console.log('memory r63 already present');
