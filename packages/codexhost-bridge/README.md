# @hmharness/codexhost-bridge

HMHarness 的 CodexHost 机器可读桥接包，提供全局命令 `hmh-codexhost`。它把 HMHarness 的 provider/model 发现和任务执行封装为稳定的 NDJSON 输出，供 CodexHost 或其他桌面宿主消费。

## 安装 / Install

```bash
npm install -g @hmharness/codexhost-bridge
hmh-codexhost --version
```

CodexHost 会自动发现 PATH 中的 `hmh-codexhost`。请先完成 HMHarness 配置（`hmh init`），再在 CodexHost 中选择 HMHarness。

## 协议 / Protocol

- `hmh-codexhost --version` 输出 JSON 版本信息。
- `hmh-codexhost providers --json` 输出 provider/model 目录，不包含 API key。
- 任务文本通过 stdin 传入，stdout 逐行输出 NDJSON：
  - `{"type":"delta","text":"..."}`：最终回答增量；
  - `{"type":"tool",...}`：工具调用状态；
  - `{"type":"line","text":"..."}`：执行循环状态；
  - `{"text":"...","sessionId":"..."}`：权威最终记录。

最终记录输出后进程立即退出，避免宿主 UI 永远停留在“正在思考”。

## 验证 / Verification

```bash
npm test -w @hmharness/codexhost-bridge
npm run build
node scripts/publish-preflight.cjs codexhost-bridge
```

## License

[MIT](./LICENSE)
