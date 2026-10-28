# REPORT:技能泛化 P1-2 单因素实验 skill-gen-p1-2-2026-10-28(前置条件感知触发匹配)

> 本文件是任务书要求的执行交付层(执行史/偏差/成本/commit 清单/复现)。
> 统计判定的机器生成全文见同目录 `machine-verdict.md`(由 `scripts/skillgen-p1-2-experiment.mts` 产出,判定语言按预注册枚举,无手工修饰);结构化数字见 `phases/analysis.json`,逐案例原始结果见 `phases/run.json`(138 条 holdout 成功轨迹 × A/B 两臂全量字段)。
> 预注册 `manifest.json` 冻结于实现之前(commit `1f606f9`,先于任何 Skill Compiler 代码改动)——这是三臂纪律的照搬:先冻结,后实现,再跑数。

## 一、结论摘要

**主终点判定:WEAK-POSITIVE(按预注册枚举字面);实质结论:主终点结构性零差,单因素的信息量全部落在匹配打分侧。**

- **因素**:前置条件感知触发匹配——把 `SkillSpecV2.preconditions[]` 从恒空建议字段(`toSkillSpecV2` 无条件 `preconditions: []`)接入挖掘(train-only 结构化前置条件:preceding 动作类型 / positionBand 位置带 / goalKeywords 关键词,各带 coverage)与匹配打分(`triggerMatchScore`,τ=0.5,冻结 check 语法)。程序体在两臂保持纯连续 n-gram——乱序/变量绑定轴明确留作下一因素。
- **主终点(泛化连续包含率 B vs A)**:三族全部 0.0pp 差、discordant 全 0、McNemar p=1。原因不是因素无效,而是**信号门没有改变选择**:三族 `selectionChanged=false`——现状排序 top-1 候选(terminal `run_command×4`、harmonyos `harmony_logs×4`、browser `type-text×4`)恰好全部自带稳定前置信号,`hasContextSignal` 门在第一顺位即放行,B 技能与 A 技能程序体逐字节相同。按冻结枚举"≥2/3 族 contB≥contA 且无恶化且无显著"字面成立 → WEAK-POSITIVE;**如实陈述:这是平局驱动的判定,主终点未被本因素改进,也未被恶化**。
- **次终点(触发精度,机制验证):effective**。挖出的前置条件确实携带真信息——匹配子集的连续包含率远高于盲触发:terminal **0.872 vs 0.486**(匹配率 M1=0.364)、harmonyos **0.500 vs 0.095**(M1=0.190,因 M1<0.2 按预注册不计入 effective 族)、browser **0.250 vs 0.100**(M1=0.400)。2/3 族满足"P@τ>contA 且 M1≥0.2" → **effective**。这正是任务书要求的"使 holdout 第 0 步不匹配的问题**可度量**":前置条件打分器把 0.49 的盲触发精确到 0.87(terminal),代价是 64% 的轨迹被(正确地)拒绝触发。
- **0.6 晋升门:全族全臂未过**(gateA/gateB 均 false;最高 0.486)。**门未降、未重定义**——技能工作流在此语料上仍不可晋升,与 0.23.29 的诚实拒绝同一结论。
- **成本**:零 LLM token(语料回放实验,无任何 API 调用;429 停相边界结构性不适用,预注册在案);wallclock ~320-350ms;全部数字确定性可复现(固定 seed、固定语料指纹 `a2ac0a29…`)。

## 二、统计判定(摘要,机器全文见 machine-verdict.md)

| 族 | holdout 成功 n | contA(A 臂) | contB(B 臂) | 差 | McNemar p | 95% CI(配对差) | M1 | P@τ | R@τ | gateA | gateB |
|---|---|---|---|---|---|---|---|---|---|---|---|
| terminal | 107 | 0.486 | 0.486 | 0.0pp | 1 | [0.00, 0.00]pp | 0.364 | **0.872** | 0.872 | false | false |
| harmonyos | 21 | 0.095 | 0.095 | 0.0pp | 1 | [0.00, 0.00]pp | 0.190 | 0.500 | 1.000 | false | false |
| browser | 10 | 0.100 | 0.100 | 0.0pp | 1 | [0.00, 0.00]pp | 0.400 | 0.250 | 1.000 | false | false |

- 判定链(冻结顺序执行):lowPower/空池族 = 0(<2)→ 非 NEEDS-DATA;恶化族 = 0(<2)→ 非 NEGATIVE;改进族 3/3 ≥2 且零恶化但显著族 = 0 → **WEAK-POSITIVE**。
- 次终点 effective 族:terminal + browser(harmonyos P@τ=0.500>0.095 但 M1=0.190<0.2,预注册条款如实排除)。

## 三、A 臂基线与历史 0.39 的关系(如实说明)

任务书以 0.39 为基线参照。0.39 是 **0.23.29 时点** real-cycle 门控的实测数字;本实验同口径(split seed `real-cycle-2026-10-07`、同 shuffle 实现、同 containment 定义)在**当前语料**(814 轨迹,较当时已增长)上测得 terminal A 臂 = **0.486**。口径一致、时点不同、语料不同——两数并报,不做混同。三族当前基线 0.486 / 0.095 / 0.100:**harmonyos 与 browser 的绝对水平本身就处于 0.1 量级**,说明这两个族的语料工作形态多样性远超单一 n-gram 的表达力(候选池 top-1 是 `harmony_logs×4`、`type-text×4` 这类重复型模式,support 虚高而语义单薄)——这是语料侧的结构事实,不是本因素引入的。

## 四、逐相 commit 清单

| 相 | commit | 内容 |
|---|---|---|
| setup-freeze | `1f606f9` | 预注册冻结:manifest(因素定义/check 语法/τ/判定枚举/诚实条款)+ 语料探查与指纹脚本(`a2ac0a29…`,三族 355/79/33 usable) |
| implement | (见 git log) | `skill-compiler.ts` 新增 minePreconditions / preconditionsFromMined / hasContextSignal / selectByPreconditionStability / compileSkillWithPreconditions / parseStructuredCheck / triggerMatchScore(+8 单元测试;build 后 typecheck 全绿) |
| run | (见 git log) | 驱动 `scripts/skillgen-p1-2-experiment.mts`(A/B 对照 + McNemar exact + seeded bootstrap + 判定枚举执行)+ `phases/run.json`(138 案例)/`analysis.json` + 敏感度脚本 |
| analyze | (本 commit) | REPORT.md(本文件)+ machine-verdict.md 机器判定(随 run 生成) |

## 五、执行偏差记录(全部留痕)

1. **驱动首跑后增补 `selectionChanged` 诊断字段并重跑**:首跑发现主终点全平局后,为把"B 选择=A 选择"这一事实显式落盘,在驱动中增加纯只读诊断字段(判定逻辑与统计零改动),重跑;多次跑的判定输出一致(WEAK-POSITIVE / effective)。偏差性质:数据呈现增强,非规则变更。
2. **敏感度分析为 post-hoc 探索性**(`phases/sensitivity-exploratory.txt`):跑完判定后读取 holdout 对候选池全量候选测包含率——按定义属偷看 holdout 的探索性分析,**仅用于下一因素假设,不计入本轮任何判定**。其发现:harmonyos 池内存在信号候选 `harmony_logs×3`(sup=10)holdout 包含率 **0.19**,是 top-1(0.095)的 2 倍——说明"有信号候选内仍按 A 序取第一"的选择规则过于保守,存在真实改进空间(见 §七)。
3. **browser 族 holdout 成功恰为 10**:预注册 low-power 线为 <10,browser 以 n=10 压线达标;其 95% CI 与 McNemar 在该样本量下功效有限,如实标注。
4. **全量 `npm test` 的 2 个 fail 已归因(非本实验改动)**:1008 tests / 1005 pass / 2 fail——两处均在 `packages/agent/src/__tests__/project.test.ts` 的 `git checkpoint: tree snapshot` 用例,错误为 `tar: Cannot connect to C: resolve failed`(Windows tar 把盘符 `C:` 解析为远程主机名的平台性环境问题)。本实验改动所在的 cognitive 包 169/169 全绿(含新增 8 测试),evolution 176/176 全绿,其余各包(kernel/observability/evaluation/sandbox/domain-harmony/cli/environments/lsp/browser/extension/web/scripts 审计/codexhost-bridge)逐包复验全绿;`npm run build` 后 `npm run typecheck` 全绿。留痕:三臂 v2 REPORT 偏差 6 记录的 evolution `Math.random()` flaky 本轮未复现(全绿)。
5. **`packages/cli/src/main.ts` 的 3 个 typecheck 错误为基线状态**:仅当 workspace 未 build(lsp dist 缺失)时出现;`npm run build` 后 `npm run typecheck` 全绿。与本实验改动无关(本实验只改 `packages/cognitive/src/skill-compiler.ts` 与新增其测试)。
6. **机器判定文件命名冲突(执行期发现并修复)**:manifest 原计划产出 `report.md`(机器判定)+ `REPORT.md`(执行报告)双文件——三臂 v2 的文件布局。但 NTFS 大小写不敏感,两名字指向同一文件,先写的机器判定被 REPORT.md 覆盖(三臂 v2 目录在 git 里同样只剩 REPORT.md——该布局在 Windows 上从未真正成立过)。修复:机器判定改名 `machine-verdict.md` 重新生成,manifest 的 artifacts 段未回改(冻结文件不改),以此偏差条目为准。

## 六、成本与配额

- **LLM token:0**(全流程零 API 调用;挖掘/打分/统计均为本地确定性计算)。预注册 manifest 已声明 429 停相边界结构性不适用。
- wallclock:实验驱动全程 ~320-350ms(含加载 814 轨迹、三族挖掘、138 案例打分、McNemar + 10k×bootstrap;多次重跑均在此量级,最终落盘 320ms);typecheck/build/全量测试时间不计入实验成本(它们是 CI 门,不是实验)。

## 七、局限与下一步

**局限**:①主终点零差源于选择门未触发,本实验无法区分"信号门规则太保守"与"信号与泛化无关"——敏感度数据(偏差 2)支持前者但属 post-hoc;②三族 top-1 全是重复型 n-gram(`run_command×4` 等),support 虚高、语义单薄,现状挖掘器的候选池结构本身限制了任何选择规则的泛化上限;③harmonyos/browser 语料小(holdout 成功 21/10),族级数字功效有限;④触发的"真值"以连续包含为代理(语料回放无法活体验证重放成功)。

**下一步(按证据强度排序)**:
1. **信号候选内的排序规则**(直接承接本因素):`hasContextSignal` 门已把池从"全部候选"缩到"有可学语境的候选",但门内仍沿用 A 序(长度优先)。把门内排序改为"信号强度/覆盖优先"或"非重复型优先",harmonyos 上有 2× 泛化空间(0.19 vs 0.095,探索性证据)——这是同一因素的第二次迭代,仍是单因素。
2. **重复型 n-gram 的去支配**:对单一动作重复≥3 次的候选降权或要求动作多样性,修正候选池结构(run_command×4 类 support 虚高)。
3. **乱序轴(15/47 全步在场但乱序)→ 变量绑定抽象**:任务书预留的下一因素,与本因素正交。

## 八、复现

```bash
git checkout <本 commit>
npx tsx scripts/skillgen-p1-2-freeze.mts        # 重算语料指纹(应得 a2ac0a29…,语料 append-only)
npx tsx scripts/skillgen-p1-2-experiment.mts    # A/B 全流程:138 案例 + 判定(确定性:同语料同 seed 同输出)
npx tsx scripts/skillgen-p1-2-sensitivity.mts   # (探索性)候选池敏感度
node --import tsx --test packages/cognitive/src/__tests__/skill-preconditions.test.ts   # 8 单元测试
```

全部确定性(固定 PRNG seed、无网络、无采样参数);复现的是逐字节输出,不只是协议。
