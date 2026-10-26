/** 0.23.41 发版准备:CHANGELOG 条目 + 16 包版本号 + 板级安装器 pins。 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const V = '0.23.41';
const entry = `## [0.23.41] - 2026-10-27

/evolve 与 /bench 全线 401 根修（密钥轮换后化石配置击穿 TUI 快路径）：①**根因**——config.json 顶层的 legacy \`provider\` 字段残留已轮换的旧 API key；普通对话走 routing 解析（providers 表新 key）一切正常，而 TUI 的 /evolve、/bench 直接把 \`cfg.provider\` 传给 chat()，全部 trap 请求带着过期 key 出门 → bigmodel HTTP 401 "身份验证失败" 全线报错。②**三层修复**——kernel loadConfig() 在 routing 可解析时将顶层 provider 派生为路由结果（化石字段永不再过期，所有 legacy 消费方一次治愈：REPL 头显、自适应上下文预算、会话元数据、web 横幅）；TUI /bench、/evolve 改用 resolveProvider(cfg,'bench'/'evolve') 目的路由；\`hmh evolve\` 命令头显同步。③**测试**——新增化石 provider 回归测试（旧 key 断言派生覆盖 + 无 routing 时透传）；954/954 零回退；用户机器 config 数据已同步修复，已装 0.23.40 实测旧路径调用即恢复。

`;

// CHANGELOG 头部插入
let ch = readFileSync('CHANGELOG.md', 'utf8');
if (!ch.includes(`[${V}]`)) {
  ch = entry + ch;
  writeFileSync('CHANGELOG.md', ch, 'utf8');
  console.log(`CHANGELOG: ${V} 条目已插入`);
}

// 16 包版本号 + root
const pkgsRoot = 'packages';
let bumped = 0;
for (const dir of readdirSync(pkgsRoot)) {
  const p = `${pkgsRoot}/${dir}/package.json`;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (j.version === '0.23.40') { j.version = V; writeFileSync(p, JSON.stringify(j, null, 2) + '\n', 'utf8'); bumped += 1; }
  } catch { /* 非包子目录 */ }
}
const rootP = JSON.parse(readFileSync('package.json', 'utf8'));
if (rootP.version === '0.23.40') { rootP.version = V; writeFileSync('package.json', JSON.stringify(rootP, null, 2) + '\n', 'utf8'); bumped += 1; }
console.log('bumped packages:', bumped);

// 板级安装器 FALLBACK_PINS(逐字节复刻 publish.cjs 的生成格式,提交源保持一致)
const pins = "const FALLBACK_PINS = {\n"
  + `  cli: '${V}', web: '${V}', agent: '${V}', kernel: '${V}',\n`
  + `  sandbox: '${V}', evolution: '${V}', 'domain-ops': '${V}',\n`
  + `  evaluation: '${V}', observability: '${V}', 'domain-harmony': '${V}',\n`
  + '};';
for (const inst of ['scripts/install-kaihongos.cjs', 'packages/cli/board/install-kaihongos.cjs']) {
  const src = readFileSync(inst, 'utf8');
  const next = src.replace(/const FALLBACK_PINS = \{[\s\S]*?\};/, pins);
  if (next !== src) { writeFileSync(inst, next, 'utf8'); console.log(inst, ': pins ->', V); }
}
