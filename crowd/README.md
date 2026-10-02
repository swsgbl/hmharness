# crowd/ — 群体经验包（匿名、内容零泄露）

这里存放**环境经验包**：多个用户用 `hmh cognitive summary` 导出的匿名摘要，经 `scripts/crowd-merge.cjs` 按指纹类合并后的产物。任何用户一条命令吸收：

```bash
hmh cognitive absorb crowd/win32-x64.json
```

## 这是什么、不是什么

- **是**：每环境×动作类型的样本数/成功率/平均耗时统计 + 粗环境指纹（os/arch/node 主版本/shell 族）。
- **不是**：没有任何任务文本、文件路径、命令内容、URL、密钥——贡献前用测试钉死了这条契约（见 `packages/cognitive/src/__tests__/crowd.test.ts` 的泄露断言）。

## 贡献你的经验（完全自愿、离线导出）

1. `hmh cognitive summary --out=my-summary.json` —— 在你自己的机器上导出（导出的是本地文件，发不发由你决定）；
2. 检查内容（就是个 JSON，肉眼可审计）；
3. 提 PR 把 `my-summary.json` 放到 `crowd/inbox/`（文件名随意），维护者会按指纹类定期合并进包。

## 维护者合并

```bash
node scripts/crowd-merge.cjs crowd/inbox/*.json -o crowd/win32-x64.json
```

不同指纹类（linux/arm64 等）会被拒绝混包——分开放。

## 原则

- 吸收永远指纹匹配 + 本地经验优先 + 来源去重（`absorbCrowdSummary` 的三条硬规则）；
- 不设遥测端点：文件往返就是全部机制，不贡献的用户不受任何影响。
