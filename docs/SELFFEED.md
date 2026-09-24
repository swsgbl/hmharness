# SELFFEED — 30 天自喂养老协议(证据工程)

**目的**:把"自进化"从机制宣称变成可审计的数据。hmharness 每天给自己安排一个
真实鸿蒙开发任务,进化轮全自动跑;所有产物(晋升、拒绝、预算、空转)**原样发布**
到官网 evidence 页。30 天后得到一份"自进化 Agent 在生产环境连续运行一个月"的
真实数据集——被拒候选与失败和晋升一样是一等公民。

**启动前提**:
- Node >= 22,`hmh` 已安装且 `~/.hmharness/config.json` 配好 evolve/bench 路由的厂商;
- 鸿蒙工具链 + 模拟器可用(任务池全部任务都在已验证的模拟器管线上);
- 预算闸门已设:config.json `evolutionBudget` 建议 `{ "cyclesPerDay": 4, "tokensPerCycle": 200000 }`,
  超预算自动跳过当日循环——协议本身不烧钱。

## 每日循环(约 10-20 分钟机器时间)

```bash
# 1. 领任务:从 scripts/selffeed-tasks.json 顺序或随机取一个(取过后删掉或标记)
# 2. 在工作区跑真任务(自动批准,但破坏性硬墙仍在):
hmh "<今天的任务文本>" --yes
# 3. 进化轮(挖掘洞察 -> 提案 -> 双门禁 -> canary):
hmh evolve
# 4. (每周一次)金丝雀判定报告:
hmh bench --impact
# 5. 导出证据并提交(这是"发布"步骤,当天数据当天可见):
node scripts/export-evidence.cjs
git add website/evidence && git commit -m "evidence: <date>" && git push
# 6. 睡前备份进化状态(单点资产):
hmh state backup
```

## 诚实规则(违反任何一条,数据集作废)

1. **只发布,不修饰**——evidence 页由脚本从 log.jsonl 生成,禁止手改生成物;
   要改展示,改 `scripts/export-evidence.cjs` 并提交,历史数据不重算。
2. **失败原样上镜**——被拒候选、retire 判定、空转日(absent/no cycles)都必须
   可见;没有晋升的日子页面就该显示没有。
3. **判定只认门禁输出**——`bench --impact` 的 promote/retire 是唯一晋升通道;
   任何"我觉得这个技能好,手动 promote"都记为协议违规(在 DEVLOG 中自曝)。
4. **任务必须是真的**——任务池只放全链可自动验证的任务;跑失败的任务
   也是有效数据(记 insight),不许挑任务美化成功率。

## 判定口径(与实现一致)

- 晋升:canary 暴露组 vs 对照组,`>=8` 会话且差 `>=10%`(impact.ts);
  数据不足输出 needs-data,不算失败。
- 成本:CJK 感知估算(ASCII 4 字符/token,CJK 1 字符/token),候选超基线
  ×cost-cap(默认 1.3)拒——防止"啰嗦作弊"。
- 预算:`evolutionBudget` 超限当日跳过,log 留痕。

## 产出物

| 产物 | 位置 |
|---|---|
| 证据页(GitHub Pages) | `website/evidence/index.html` → https://swsgbl.github.io/hmharness/evidence/ |
| 原始日志副本 | `website/evidence/raw/{log,pareto-entries,insights}.jsonl` |
| 进化状态备份 | `~/.hmharness/backups/<ts>/`(每日一份,`hmh state list` 查看) |

## 30 天后的动作

1. `hmh bench --impact` 出首份完整判定报告;
2. evidence 页归档为"第一个 30 天数据集"(不再覆盖,复制为 evidence/ds-2026-09/);
3. 写复盘:哪些晋升是统计可靠的、哪些是噪声、下月任务池怎么改;
4. README 的自进化章节脚注从"收集中"改为"已发布,见 /evidence"。
