# hmharness 开发日志(DEVLOG)

以轮次记录重大演进。每轮:动机 → 关键决策 → 实测证据 → 教训。

---

## 2026-09-05 · GitHub 中文门面 + npm 预检 + 视觉回归 + 镜像诚实检查(收尾批)

**动机**:用户令"继续全部,逐个推进"+附 GitHub 主页截图指出缺中文介绍。
ROADMAP 剩余四项一次推进。

**GitHub 中文门面**:仓库 description 改为**中文优先双语**(中文定位+
英文关键词共存,两语搜索都命中);topics 上限 20——移除弱泛化(testing/
devtools/cli/nodejs)换精准中文生态词(ohos/arkui/cangjie/self-evolving-
agent)。README 本已是中文,无需动。

**npm 发布预检(scripts/publish-preflight.cjs)**:发布是七包**有序集**
(kernel→evolution→domain-harmony→domain-ops→agent→web→cli),预检五道:
dist 新于 src/shebang/dist 中 @hmh/* 导入必须在 package.json 声明/
npm pack --dry-run/dist 密钥扫描。**当场抓出 11 处真问题**:两个包 dist
stale(提交后忘重建)+九处 @hmh/* 导入未声明(发布后用户 install 必炸的
坑)+cli 漏声明 @hmh/web——全部补齐后 PREFLIGHT OK;已挂 CI(只检不发)。
首发指令固化在脚本输出里。

**视觉 UI 回归(uiregress.ts,quality 三件套其二)**:launch→hdc
snapshot_display 截屏→vision 描述→**关键词断言**;每个判定**引用模型原话**
(可审计,永不"看起来不错"盲过);语义存在性检查而非像素 diff(像素 diff
被模拟器 GPU 字体渲染差异打穿)。**真机验收**:截屏 79KB 真 JPEG,vision
在截屏上读出 **"Hello HarmonyOS"**(脚手架 Index 页面真渲染);首跑遇
HTTP 429 为本地网关瞬态限流,重试即过(教训:外部服务状态先重试再定性)。

**镜像下载诚实检查(harmony_image_check)**:华为只经 DevEco 账号绑定
组件管理器发镜像,无公开 URL 通道——不写死代码假装能下载;探测工具
报告**已装镜像(API 6.1.1-B1/phone_all_x86)+已装类型实例全自动+未装
类型的唯一人工步骤指路**。真机验收:正确列出 installed 与"phone"未装
的诚实报告。

**实测**:全套 88/88;preflight OK;dist 六项验证;GitHub API 双操作
(description/topics)即时生效。

**教训**:㉚发布多包必须预检"有序集"——单包看不去的缺声明,`npm pack
--dry-run` 不查依赖可解析性,预检脚本是唯一防线;㉙瞬态外部故障(429)
先重试再定性,验收输出里保留完整错误串方便分辨"代码 bug"与"服务状态"。

---

## 2026-09-05 · API 知识图谱 + 消息通道(旧线最后两项落地)

**动机**:用户令"继续推进"。旧线五缺口剩余 api_kg 与 channel 可落地项
(cybernetics 维持实验排期)。

**API 知识图谱(apikg.ts,旧线 api_kg 缺口)**:
- **动机的根**:agent 猜鸿蒙 API 因为它**看不见 SDK**——而 927 个 d.ts
  声明文件就在磁盘上。索引一次,查证每个符号:声明片段+file:line 证据+
  kit 归属;"查不到"=本 SDK 无此符号,**幻觉被索引拦截**
- **索引器**:行式宽松解析 d.ts(export default class/declare namespace/
  interface/enum/成员方法属性含 `?` 可选/const/静态),提取 @kit 标签;
  **实证 20,241 符号/0.2s**,缓存于 HMH_HOME/apikg(SDK mtime 变化才重建,
  重载 44ms)
- **harmony_api_lookup 工具**:符号直查(支持 hilog.info 层级形式),返回
  精确命中+相似候选;**假符号诚实拒**("not in this SDK - do not guess")
- 解析器四轮测试驱动修正:`Want`(export default 形态)/`hilog`(namespace
  形态)初始全漏——d.ts 声明形态比想的多样;正则的 `\(?:` 转义错误逐字符
  debug(execute 层字符类错吃整组)

**消息通道(channel.ts,旧线 channel 缺口,诚实最小版)**:
- **ops_notify** 工具:飞书(HMAC-SHA256 timestamp 签名)/钉钉(签名 URL
  query)/通用 JSON webhook 三型;配置在 HMH_HOME config.json 的
  channels{}——**webhook URL 是准密钥,不进仓库**;未配置=友好提示带
  配置样例;出站消息挂审批门
- 用途:任务完成/构建结果/设备测试判定推送到群——"模拟器装完了告诉我"

**红线保持**:索引只读 SDK、缓存只写 HMH_HOME;webhook 走审批门。

**实测**:apikg.test.ts 3 用例(解析器全形态/lookup 精确+模糊+假符号/
channel 未配置提示+本地 stub 服务器真实 POST 往返);真 SDK 烟测
(UIAbility/Want/hilog/HashMap 命中带 kit 与行号,NonExistentFake 拒);
全套 **88/88**;七包构建+dist 四项验证。

**教训**:㉘"看不见的知识"先建索引再谈提示词——agent 猜 API 不是模型
笨,是证据链缺失;索引+file:line 证据让错误在写码前暴露;㉙正则 debug
用最小复现行逐字符过,别盯着整段代码猜;㉘复训:e2e(真 SDK 20k 符号)
再次抓出单测(合成样本)漏掉的声明形态多样性。

---

## 2026-09-05 · 签名封装+设备测试:hapsigntool 全链破案(设备实证)

**动机**:继续推进 ROADMAP 域缺口最后两项:hapsigntool 签名封装+onDeviceTest。
模拟器在线,一切可实证。

**破案过程(五关,全部设备实证)**:
1. **mode 词汇**:hapsigntool 的 -mode 要 `localSign`(不是 debug/release)
2. **过期模板**:SDK 的 UnsgnedDebugProfileTemplate.json 自带 2021-2023
   validity——**今天已过期**(verify-profile 实锤 not-after=1705127532)。
   解:克隆模板刷新为 now..+30y(换 uuid)→ ensureDebugProfile 自动生成
3. **别名谜题**:p12 有 8 个别名(keytool -storetype PKCS12 列出);经组合
   穷举实证:**sign-app 的 keyAlias 是 `openharmony application profile
   debug`**(不是直觉的 application release——那张是自签证书,链验不过)
4. **证书链**:appCertFile 用 OpenHarmonyProfileDebug.pem(内含 3 张证书
   的三级链,OpenHarmony.p12/Profile pem 本就是 profile 链不是 app 链)
5. **hdc 路径坑**:hdc install 只吃反斜杠 Windows 路径,正斜杠被当相对拼接

**设备实证**:签名后的 hap(54404b)在模拟器 install→launch→hilog 回读
`EntryAbility onCreate`——**自己签的应用真的跑起来了**。

**落地**:
- **signing.ts**(重写):hapsignToolPaths(jar/p12/pem/template/java 五件
  定位)/resolveSigningIdentity(explicit 覆盖>SDK 身份,诚实注明
  ~/.ohos/config 是句柄非文件,不走假路径)/ensureDebugProfile(自动刷新
  过期模板+sign-profile)/signHap(实证组合)/harmony_sign 工具(默认
  全自动:找最新 unsigned hap→生成 profile→签出 -signed.hap)
- **ondevice.ts**:runDeviceTest 四步判定回路(install→launch→hilog
  轮询断言生命周期标记≤6s→cleanup uninstall,install 失败短路;
  **runImpl 注入缝**=测试确定性,顺修 .cmd shim EINVAL 老坑的绕行)/
  harmony_device_test 工具(自动寻最新 signed hap+bundle 从 AppScope 读)

**最终验收(全自动化,清空 tmp 从零跑)**:harmony_build OK→harmony_sign
(profile 自动生成+签名 OK)→harmony_device_test 四步全 PASS
("the app really installed, launched and logged on device")。

**实测**:signing.test.ts 5 用例(身份解析优先级+SDK 回退+四步判定+
install 失败短路+marker 缺失诚实 FAIL);全套 **85/85**;七包构建。

**教训**:㉕文档之外的唯一裁判是工具自己的报错——hapsigntool 每一步
(mode/别名/链/过期)都是被它的错误消息逐级教育出来的,-h 帮助+错误
码是第一手资料,二手教程全都过时;㉖过期证书类"玄学失败"先 verify-profile
拿 not-before/after 数字再说话;㉗组合穷举是破签名矩阵的正路(2×3 组合
就出了唯一解),别在单一组合上反复撞墙。

---

## 2026-09-05 · 设备回路打通(模拟器)+ 编译-修复闭环 + 项目画像

**动机**:用户问"真机回路 blocked 是指链接手机吗?模拟器可以吗?模拟器已开,
其他项继续"——正确!e2e 走 hdc 通道,模拟器(127.0.0.1:5555)对 hdc 就是普通
设备,block 当年只是"无任何设备在线"。模拟器已开=blocked 解除。

**设备回路全链实证(一次过)**:升级 scripts/e2e-device.mts(补 schema_check
前置门+uninstall 清理步),对模拟器跑完整生命周期:
scaffold(19 文件)→schema_check(3 配置全过)→harmony_build(BUILD
SUCCESSFUL)→install(bundle installed)→launch(start ability
successfully)→**logs 真实回读到应用自己的 `EntryAbility onCreate`**(应用
确实在模拟器上活了)→uninstall(clean)。**全链零人工介入**。

**编译-修复闭环(builddoctor.ts,旧线 icf 缺口)**:
- **harmony_build_doctor**:hvigor 失败日志→七类已知签名分类(sdk-home/
  signing/ohpm-deps/hvigor-env/arkts-source/config/network)→每类给**具体
  修复动作**(不是"去搜报错");未知签名**不隐藏**——原样透传尾部+首错块,
  反复出现的模式该进签名表;首 ERROR 块单独提取(file:line:pos)
- 测试 3 用例:七类全命中+未知返回 null+首错块提取;profile 画像准确性

**项目画像(profile.ts,旧线质量三件套基座)**:
- **harmony_project_profile** 一次调用回答"这是个什么项目":模块清单
  (type/pages/abilities/deviceTypes)、entry 的 har 依赖边、资源与源码
  计数、bundle/SDK、配置健康(对接 schema_check 的 issue 计数)——
  改动规划与工作量估计的起手式
- 旧线五缺口处置:icf(编译修复)✅ 本轮;quality(画像)✅ 基座本轮
  (回归+评分待视觉/真机配合);api_kg(知识图谱)/channel(消息通道)/
  cybernetics(控制论)维持排期

**坑(教训㉔三次重演,升级为铁律)**:脚本(node fs.writeFile)改
src/index.ts 又被 ACL **静默吞写**(输出"成功"但文件未变+残留半截拼接行)——
**此类文件一律改用编辑器工具直写**,shell 脚本改文件在本机此文件上已三次
失败,不再尝试。

**实测**:doctor.test.ts 3/3(含 profile 对真实 scaffold 的模块/页面/依赖
断言;顺修 countFiles 深度 3→6 的目录遍历 bug);全套 **80/80**;七包构建
+dist 四项验证;dist 冒烟:profile 输出完整画像(2 模块/2 页面/4 源码/
deps 边/健康 OK),doctor 对合成失败日志输出 kind+evidence+fix。

---

## 2026-09-05 · 域缺口补齐:项目 schema 校验 + API 能力矩阵

**动机**:用户令"继续"。ROADMAP 域缺口里最可落地的两项:schema 校验
(module.json5/build-profile.json5 结构验证——工具链失败前的第一道网)与
API-level SemVer 矩阵(26.0.0 起版本改版适配)。

**落地(domain-harmony)**:
- **schema.ts**:宽松 JSON5 解析(行/块注释+尾逗号+单引号,字符串感知——
  闭环号单引号曾漏转义,测试当场抓住)+module.json5 结构校验(name/type
  枚举 entry/feature/har/shared/entry 的 mainElement+deviceTypes 必填)
  +build-profile 校验(root: app.products[].compatibleSdkVersion+modules;
  module: apiType=stageMode+targets);**新工具 harmony_schema_check**
  (只读,构建前跑,把 3 分钟的 hvigor 深层失败换成毫秒级"精确字段名"报告);
  模块目录判定=有 src/main/module.json5 或 build-profile 才查,AppScope
  等非模块目录静默跳过(e2e 冒烟抓到的真 bug:缺失文件被当解析错误误报)
- **apimatrix.ts**:双形态版本解析("6.1.1(24)" 遗留式 vs "26.0.0"+ 纯
  SemVer——26 起 major 即 API level,改版适配只在此一处)+compareSdk+
  能力矩阵(shared-module/2in1/semver-numbering 等条目,可扩展)+
  **scaffold 接入**:坏 HM_SDK_VERSION 在脚手架入口即报错(带期望格式),
  不再留给 hvigor 报天书

**实测**:schema.test.ts 6 用例(JSON5 容错+坏 JSON 报错/entry 必填三态/
root+module 校验/整项目扫描:合法过+损坏精确捕获/双形态版本+垃圾抛错/
排序+矩阵跨 26 开关门控);**e2e dist 冒烟 4/4**(真 scaffold→schema_check
通过→故意损坏 module.type→输出精确点名→apimatrix 导出往返);全套 77/77;
七包构建+dist 三项验证。

**教训**:㉔脚本改关键文件必须回读验证——本轮 src/index.ts 的接线脚本
"成功"输出但写入被 ACL 静默吞掉,靠 dist 字节验证才暴露(与 index.ts.bad2
同源);**写完就 console 回读**应成为脚本改文件的固定动作;㉑复训:e2e 冒烟
再次证明其价值——单元测试 6/6 全绿的情况下,真脚手架扫描仍抓出
"缺失文件≠解析错误"的分类 bug。

---

## 2026-09-04 · 门禁方法学升级 + 雷达信号接入(ROADMAP 收官批)

**动机**:用户令"继续推进计划"。自进化蓝图 P0-P3 落地后,ROADMAP 上最顺承
的两项:门禁方法学(bench 断言升级+成本双指标)与进化循环接入雷达信号源。

**门禁方法学(bench.ts+evolve.ts)**:
- **结构化断言四模式**:`expect-exact:`(精确等值,容忍首尾空白但不容忍任何
  多余字符) / `expect-regex:`(正则匹配;**坏正则=判例错误而非通过**,防自欺
  门禁) / `expect-none:`(失败标记禁词——"OHM OK (error ignored)"这类
  啰嗦但错误的输出被否决) / `expect-any:`(至少一个候选命中);旧 `expect:`
  子串语义完全不变(向后兼容,旧用例零改动)。matchCase 单一入口逐模式校验
- **成本双指标门**:runAndAssert 收集每用例输出成本(粗估 tokens=chars/4),
  候选任一用例成本 > 基线×cap(**默认 1.3x**,用例可用 `cost-cap:` 行自定义)
  → 拒绝并记"cost regression"入 Pareto 存档——"靠啰嗦通过"的候选从此过不了
  门;成本仅做否决不做唯一判据(pass-rate 门仍主导)

**雷达信号源接入(evolution/radar.ts)**:
- latestRadarBrief:读 ops 保管员的最新生态简报(≤14 天新鲜度,1200 字截断,
  过期/缺失=null)
- 进化 signals 增 `ecosystemNews` 字段;提议提示词加引导("若简报提及近期
  OpenHarmony 发布,优先提议顾及它们的方案,不要给过时的工具链建议")
- **只读不触发**:进化永不自己跑扫描(`hmh ops scan` 有自己的预算),只消费
  保管员已发布的简报——职责与预算边界清晰

**实测**:gate.test.ts 7 用例(exact 三态/regex 匹配+坏正则报错/none 禁词否决
/any 二选一/legacy 子串兼容/新旧行解析含 cost-cap/雷达简报缺失-过期-新鲜三
态);全套 **71/71**;七包构建+dist 六项字节验证(matchCase/expectExact/
costCap/成本否决/ecosystemNews/radar.js 全在)。

**教训**:㉑门禁质量=进化质量上限:子串匹配会放行"包含关键词但整体错误"的
输出,exact/none 模式是防"聪明作弊"的最低配置;㉒成本必须是第二判据而非
唯一判据——只用成本门会否决合理长输出,只用 pass 门会放行啰嗦作弊,双指标
各管一半;㉓跨模块信号接入要"只读消费,不越预算"——evolution 读 ops 的
产物但不触发 ops 的工作,否则预算闸门形同虚设。

---

## 2026-09-04 · P2 推理时进化 + P3 拓扑最小版(蓝图收官)

**动机**:用户令"继续推进计划"——P0/P1 已落地(6ea9007),按验证蓝图执行
P2(推理时进化+静态知识刷新)与 P3(拓扑最小版),自进化升级四段全部收官。

**P2 落地**:
- **高代价命令预检**(commandPreflight,tools.ts):hvigorw/hdc/ohpm/npm 等构建
  类命令执行前先验"相对脚本是否存在于 cwd"(hvigorw.bat 不在=毫秒级报错,
  而非烧 3 分钟构建才发现)——Self-Refine 验证教训:验证器要校验"修法对
  不对"而非"改没改"(61% 失败是修法错)
- **CRITIC 结构化反思**(run_command 第 2 次失败):失败输出追加诊断要求——
  ①LOCATE 精确定位失败阶段 ②HYPOTHESIZE 一句根因 ③才允许换策略重试;
  第 3 次仍短路。Reflexion 信号放大:低带宽失败信号必须升格为结构化语言
  经验才跨轮迁移(94% 反思失败源于坏反馈:33% 定位错+61% 修法错)
- **静态知识刷新**(evolution/knowledge.ts):鸿蒙官方 release-notes 索引
  快照→词级 diff→元模型蒸馏"知识补丁"技能草案→防投毒→writeDraft,**走
  既有 draft→双门→canary→impact 管线,零新口子**;离线=干净 no-op
  (best-effort 永不成为用户要处理的失败)

**P3 落地(spawn_agent 角色锦标赛,诚实最小版)**:
- spawn_agent 增 `role` 参数(explorer/reviewer/build-fixer…);每次带角色的
  委派记录 ok 率(turn 预算内+零工具错误)到 evolution/spawn-roles.jsonl
- 下次带角色委派时,父模型在子代理系统提示词里看到排行榜(≥3 样本才入榜)
  "explorer 67% (3x), prefer high ok-rates"——模型自己学会不再把任务派
  给垫底角色。无 MARL、无辩论,单 Agent 产品里的多智能体协同进化=可读的
  角色战绩榜

**红线**:全部不变(进化写域/永禁 kernel 四件/评估细节不可见);预检与 CRITIC
都在**工具层**硬执行(教训①重申:提示词防线对模型习惯行为不够)。

**实测**:p2runtime.test.ts 5 用例(预检:便宜命令直通/缺失脚本拦截/存在
放行/PATH 命令不预检;CRITIC:一次失败裸错/二次失败带 LOCATE+HYPOTHESIZE/
三次短路不执行;knowledge:快照持久化+diff 路径+离线 no-op;P3:角色记录/
聚合/≥3 样本门槛+排行线);全套 **64/64**;七包构建+dist 五项字节验证
(knowledge.js/commandPreflight/CRITIC 文案/spawn-roles/index 导出全在)。

**教训**:⑲推理时进化的正确位置是工具层而非循环层——run_command 的
失败计数器已经是事实上的"推理时状态机",把 CRITIC/预检挂在那里零新协议、
零 kernel 改动、测试直接可断;⑳"最小诚实版"原则再验证:角色排行榜比
MARL 适合单人 CLI 框架(可解释/零新依赖/可关闭),不追论文豪华版。

---

## 2026-09-04 · 自进化生产化轮(P0 可观测+P1 种群化,论文验证驱动)

**动机**:用户令用 XMUDeepLIT/Awesome-Self-Evolving-Agents 综述做差距分析+生产
级升级蓝图,"搜索全网验证补全,最后根据结果来执行全面升级"。

**调研(12 篇论文原文逐篇验证,两个并行 agent)**:综述六维分类法逐条核对
(Model-Centric Inference/Training;Environment-Centric Static/Dynamic/Modular/
Topology;Co-Evolution)。**验证推翻了初版蓝图三处转述失真**:①GEPA 不是
"k 候选并行采样选优"——原文是 Pareto 前沿**单祖先单变异稳态遗传循环**;
②DGM 死因不是"漂移"(v1/v3 全文 drift 0 命中)——是 **objective hacking**
(node 114 绕过评估函数,类比 reward hacking+Goodhart);③ACE 无"bench 门控
版本化"——真实机制是 embedding 去重+上下文长度触发修剪。**Voyager 教训反转**:
"技能库膨胀"论文当卖点(ever-growing 缓解遗忘),全文无任何生命周期管理——
膨胀是真实但被论文忽视的缺口,做 merge/decay 是补课不是复现。**新成立教训**:
Self-Refine 94% 失败源于反馈质量(33% 定位错+61% 修法错);Misevolve 实证
memory 进化→safety alignment decay+部署期 reward hacking,缓解="references
not rules";AWM 工作流归纳+选择性注入完全属实;Agent KB 分层检索(workflow 级
规划+execution 级纠错)+分歧门控。验证后蓝图:**docs/research/self-evolution-upgrade.md**。

**P0 落地(可观测性——一切算法的前提)**:
- **血缘账本**:ProposalOutcome.lineage{parentInsights,scores,metaModel,
  decidedAt}三落点;Insight.skillsInjected 注入键;evidence/report 不可审计→可审计
- **金丝雀晋升**:promote 默认目标=**canary 态**(过双门只赚实验位,不直接
  全量);~20% 会话确定性采样注入(session hash 稳定归因)+Misevolve 水印
  "references not rules";`hmh bench --impact`:暴露组 vs 对照组 ≥8 会话且
  成功率差 ≥10% 才 promote/retire,数据薄=诚实 insufficient-data——**objective
  hacking 的结构性防线:不信进化系统自己能看到的指标,信对照组**
- **进化预算闸门**:config.evolutionBudget{maxCyclesPerDay,maxTokensPerCycle},
  当日超限 skip 并记 budget 行(AZR"safety alarms"教训:无界自进化失稳)
- **技能算子**:pin(用户钉住永不被进化动)/promoteCanary/retireCanary(退回
  draft 不删,只增不删红线)/decay(30 天零注入→dormant 出注入集,Voyager
  补课)

**P1 落地(GEPA 化,忠实原文机制)**:
- **Pareto 候选池**:被拒候选持久化 evolution/pareto/entries.jsonl(带拒因+
  skillMd 快照)——GEPA/DGM 共同支柱:多样性存档防局部最优
- **单祖先变异**:每轮从池中随机采 ONE 祖先喂 proposeSkills("learn from why
  it failed, propose a VARIATION"),互补拒因 30% 概率 Merge 交叉——原文
  Algorithm 1 机制,非 k-候选锦标赛
- **AWM 工作流归纳**(workflows.ts):洞察按任务原型聚类(归一化前缀),同型
  ≥3 次→元模型归纳 {{参数化}} 工作流模板(带触发条件)→走**既有** draft→
  防投毒→双门管线(不开新口子);常规 propose 空转时才触发(预算友好)

**红线全部保留**:进化写域仍限 skills/+memory/+已批补丁;kernel
loop/provider/config/security 永不可触;评估细节(bench 用例)永不进进化元
模型提示词(objective hacking 防线)。

**实测**:新 impact.test.ts 9 用例(canary 采样确定性+~20% 分布/预算读数/
Pareto 存取+祖先+Merge/draft→canary→promote→active 全链/retire 不删/promote
判定 ≥10% 边界/insufficient-data 下限/pin 豁免 decay+30 天安静/AWM 聚类);
skills.test.ts 更新为 canary 协议(顺带修真 bug:re-promote 占用 canary 目录
EPERM→canary 前任也入 archive);全套 **59/59**;七包构建+dist 六项字节验证
(impact.js/workflows.js/lineage/canary/skillsInjected/--impact 全在);空 home
`bench --impact` 冒烟"no canary skills under evaluation"诚实输出。

**教训**:⑯引用论文教训前必须回原文核对——本批 5 处主张 2 失真 1 反转,
未核对的"文献驱动开发"等于传闻驱动;⑰P0 可观测先于一切算法:没有归因
闭环,GEPA/金丝雀的效果与运气不可分;⑱机制升级要顺着既有门禁管线开
(AWM 走 draft→gate 而非另开口子),新能力=新风险面。

---

## 2026-09-04 · TUI /model 选择器交互修复轮

**动机**:用户实测反馈"tui 界面的 /model 列出来的模型列表,上下键无法选择,用鼠标
也选中不了"。截图取证(输入框为空、模型列表是转录区普通文本)定位真相:代码逻辑
无 bug(无头 5/5 PASS),用户走进的是**裸 `/model` 命令打印的静态列表死路**——该列表
纯文本、无可选项;活面板只在输入含 `/model…` 时存在,命令跑完输入清空,面板就没了。
另有暗雷:输入 `/model` 直接回车会**静默切到第一个模型**(Enter 语义过急)。

**落地**(tui.ts / i18n.ts,对标 Claude Code 两段式选择器):
- 裸 `/model`+Enter **打开交互选择器**而非打印死列表(转录留记录+聚焦活面板,
  openModelPicker);`/model <name>` 手输路径不变
- Enter 语义分层:输入恰为 `/model` → 开面板不执行;`/model `(已进面板)或带过滤
  词 → 选中高亮行并执行。第一记 Enter 不再误切模型
- **Esc 关闭面板**(清草稿;精确匹配 `\x1b`,箭头序列不受扰;顺手删除了 onKey 尾部
  重复的旧 Esc 分支)
- **滚轮优先驱动面板**:面板开着时 SGR 滚轮事件移动选择(此前滚轮只滚转录,面板
  视若无睹);面板关着仍滚转录
- 面板底部常驻 **i18n 提示行** `panelHint`(↑↓/滚轮选择·Enter 确认·Esc 关闭,
  zh/en 双语),选择器从此无需看文档即可上手;cmdModel 描述同步改写
- 布局账本:提示行计入 cmdRows(+1),viewH 同步,转录不被挤爆

**实测**(tui.test.ts 新增 5 个 runtime 级用例,真 stdin data 接线喂键,非 mock):
裸 /model+Enter 不触发命令且聚焦面板 ✓;↓↓+第二记 Enter 提交
`/model nvidia-vision` ✓;SGR 滚轮上下移动选择 ✓;Esc 清空 ✓;斜杠命令面板
`/m`+Enter 仍取 COMMANDS 序首项(实测序为 /model,顺带发现其提交即路由进选择器,
行为自洽)✓。全仓 43/43 绿,typecheck+七包构建+dist 冒烟(skills/no-TTY 双语)过。

**教训**:①"代码正确"≠"用户可达"——活面板逻辑全对,但一条静态列表死路就把用户
挡在门外;交互入口必须收敛到单一活物;②Windows ACL 坑:某次提权进程构建出的
dist/patches.* 带 Users:RX-only 继承 ACE,普通 shell 下 rename 可行而 delete/open-write
EPERM——绕行(改名让路+重建),根因留 elevated 清理;③npm 在本机 shell 偶发
"Invalid abbreviated flag"启动失败,直跑 tsc/`node --import tsx --test` 稳定。

**第二轮(同日,用户复测后)**:用户仍报"上下键选不了、鼠标也选不了",且点名
**TUI 没有语言切换命令**。两个真因+一个缺口:
- **SS3 光标键**:上个程序可能把终端留在 DECCKM(应用光标模式),方向键以
  `\x1bOA/B` 而非 `\x1b[A/B` 到达——原代码只匹配 CSI,SS3 被末尾的
  `data.startsWith('\x1b')` 静默吞掉,症状恰是"按了没反应"。修复:启动/退出均写
  `\x1b[?1l` 强制 CSI;onKey 顶部 `\x1bO[A-H]`→`\x1b[A-H]` 归一化(双保险)
- **conhost QuickEdit**:用户点列表想"选中"→终端进入文本选择模式,方向键被终端
  吃掉移光标选文本,应用收不到。修复:**面板=模态**——面板开着时自动开
  SGR 鼠标上报(1000+1006),**点击=选中并确认**(render 记录每行的屏幕行号,
  SGR row 1:1 命中)、滚轮驱动选择;面板关闭(Enter/Esc/清空)立即关上报,
  原生拖选复制即时恢复。/mouse 全局开关与模态上报合并成单一
  syncMouseReporting 状态机
- **缺口:/lang 命令**——此前 TUI/REPL 无界面语言入口(只有 --locale/HMH_LOCALE/
  Web 芯片)。新增 `/lang [zh|en]`(省略则中英切换):kernel setLocale 持久化
  (setChatRoute 同款读改写)+ TUI 运行时全量刷新(rt.configure+strings 重绑)+
  REPL 同步获得;nextLocale 纯函数可测

**实测**:TUI 测试 12/12(SS3 上下键导航/模态上报开-关/点击第 3 行提交
`/model nvidia-vision`/nextLocale 边界);全套 48/48;dist 字节级验证(?\1l、SS3
归一化、点击正则、syncMouseReporting、/lang 全在);setLocale 经 dist kernel
隔离 HMH_HOME 往返持久化实证;REPL /lang 交互节奏冒烟(spawn+延时写入模拟真人)
——切换行+切换后 /help 以英文渲染(证明运行时刷新而非仅落盘)。管道整块喂入的
"多行丢失"是 readline 行交付竞态(历史坑),交互终端不存在。

**教训**:④"无头通过"只覆盖程序一半,终端是另一半——终端模式残留(DECCKM/
QuickEdit)能把正确的键处理整个短路;对键盘/鼠标类交互,要么真终端实测,
要么把终端的两态(CSI/SS3、上报开/关)都纳入无头矩阵;⑤多行管道冒烟必加
逐行延时,await 间隙里的行会被 readline 丢掉,交互终端不存在。

**第三轮(同日,/mouse 移除)**:用户质问"/mouse 存在的意义是什么""你想给自己
留历史代码包袱吗"。盘点:模态上报+终端滚轮转换已覆盖 conhost/WT/VS Code 全部
目标环境,/mouse 唯一受益者是 tmux/个别 Linux 终端用户——而本项目定位
Windows/HarmonyOS 开发机,受益者集合为空。保留=为不存在的用户维护开关+
i18n 键+文档心智负担。**删除**:COMMANDS 项、handleLine 分支、toggleMouse、
mouse 字段、状态行 /mouse 提示尾巴、i18n 六键(mouseOff/cmdMouseOn/Off/
cmdMouse,zh/en+接口)——syncMouseReporting 简化为纯模态(面板开→上报,
面板关→还原,零用户可动开关)。**教训**:⑥兜底开关不是免费品——每个开关
都是文档、i18n、测试和用户心智的永久负债;兜底只在"目标用户里真有人踩"
时才值得留,否则就是历史包袱。

**第四轮(同日,双菜单根除+全量扫描)**:用户截图抓到裸 /model 输出**两个模型
菜单**——一个可选中(活面板)一个不能(静态列表)。根因:上一轮修 /model 时
只改了键盘路径(输入框直敲回车),**没改驱动路径**(/斜杠面板选中 /model 命令
进入同一 handleLine,却仍打印静态列表+开活面板)——"修症状不修路径"的复发。
用户令"全量扫描整个工具确保无同类问题",建立三道脚本化扫描:A 硬编码
UI 文案(addText/stdout.write 含中文且无 t.) B COMMANDS×REPL/TUI 处理器
矩阵 C dist 双菜单残留。**修复**:①裸 /model 不再打印静态列表,活面板是
唯一菜单(transcript 断言钉死:无 `z-ai — ` 静态行;键盘/面板两入口同一
openModelPicker);②扫描抓出三处漏网硬编码(/providers scan 成功文案、
/providers 列表尾巴、REPL [thinking] 标签)全接 i18n(复用 cmdProvidersAdded,
新增 cmdProvidersScanHint/thinkingLabel);③REPL 两缺口补齐(/providers [scan]
TUI 有而 REPL 报 unknown command、/clear 同缺)——COMMANDS×处理器矩阵全绿。
**实测**:TUI 13/13(新增面板路由单一菜单断言);全套 49/49;REPL spawn+延时
实证 /clear//providers 生效+无 unknown command;三道扫描 ALL CLEAN。
**教训**:⑦同一动作的多条入口路径必须收敛到同一出口——修交互 bug 时要枚举
"用户到达这里的所有路径",只修自己想到的那条=给用户留另一条坏路;⑧扫描
要脚本化且可重跑(人眼审一遍会漏,正则矩阵不会)。

**第五轮(同日,头部状态诚实化)**:用户问"右上角的空闲是不是历史包袱?"。判定:
**标签该留,但它在说谎**——头部右侧永远显示"○ 空闲",任务运行中也不变(状态行
虽在输入框上方给出运行中,但右上角的"空闲"是睁眼说瞎话);标签的真实价值=
YOLO🔥 模式徽标的挂载点+与 Web 顶栏同构。**修复**:头部状态随 busy 轮换——
空闲=绿色"○ 空闲",忙碌=黄色"运行中…",模式徽标两种状态都保留。
paletteProbe 增加 frameText(捕获真渲染帧,按 CUP 行序列拆行+剥 ANSI——
期间测试抓到并修正:①拆行正则首版把整帧吃空;②setModeTag 后须重新探测,
旧帧不含新徽标)。**实测**:TUI 14/14(新增头部诚实测试:空闲↔运行中轮换、
忙碌时无"空闲"残留、🔥 两态可见);全套 50/50;dist 字节验证(忙碌轮换在,
空闲态保留)。**教训**:⑨状态指示器的唯一职责是真话——宁可没有指示器,
不能有会说谎的指示器;"运行中"只在状态行、头部却写"空闲"=同一状态两处
两种说法,必错一处。

**第六轮(同日,回滚 18210e1+定案台账)**:用户严正指出——"之前就让你更改位置的,
怎么现在又恢复了""每次更改你都不做日志管理吗,不更新技术清单文档吗?为什么
出现这种牛头不对马嘴的低级错误?"。**事实**:0df4ba7(2026-09-03)已定案
"状态行迁输入框上方,头部右侧**永远**只显示 ○空闲+🔥";18210e1(本轮"空闲
是不是包袱")未查任何决策记录,凭单轮判断把头部改回运行轮换=**回退已定案
设计**。**根因(三重失守)**:①设计决策只散落在 git 注释/DEVLOG 正文,无
"当前有效"单一事实源,跨会话上下文压缩后不可靠;②面对"是不是包袱"类
质疑,我的默认动作是"动手改",而非"先查有没有定案";③改动未执行
"先查文档再动代码"流程。**止损**:①回滚头部行为至定案(测试断言同步改回:
头部静止+状态行唯一运行指示);②**新建 docs/DESIGNS.md 定案台账**——
TUI 8 条/Web 4 条/CLI 2 条已生效决策+提交号+复案登记规则(推翻定案必须先
登记理由);③顺带修 frameText 探针真 bug(按 ESC 前缀过滤行会丢弃所有带
颜色样式的行——恰好是最需要断言的行;改按 CUP 分隔奇偶取行再剥 ANSI)。
**实测**:TUI 14/14(新断言:头部忙碌时仍○空闲+状态行"运行中…"在+🔥两态
可见+空闲时状态行隐藏);全套 50/50。**教训**:⑩已交付的交互=已签署的
契约,任何"改进"冲动先过定案台账;文档不是事后补写,是改代码的**前置**
步骤;⑪对"X 是不是包袱"类问题的正确流程:查台账→有定案则回答"是定案,
理由如下"→无定案才进入提案;⑫单一事实源原则——决策散落多处=没有决策。

**第七轮(同日,T1-v2 用户定案)**:用户第三次澄清原意:"我的意思是这两处状态
是**重叠的**——状态已经更改到输入框上面了,**右上角的状态功能应该删除**,
否则是包袱。既然更换了位置,就应该把旧位置的删除,这不是常识吗?"——
至此真相完整:0df4ba7 迁位时**没删旧位**,右上角留下一个永远"空闲"的孤儿
状态位;18210e1(改成轮换)和 af09228(恢复空闲字样)两轮都在错误的问题域里
打转,我甚至用"定案"为孤儿位辩护。**执行**:①右上角状态字样全删(tuiIdle
键从 i18n 三处移除,零引用即删);②🔥 徽标并入头部左侧身份条(技能数之后);
③头部=纯身份条(logo/模型/cwd/技能+🔥),测试断言:帧内无"空闲/idle"字样、
状态行为唯一运行指示、🔥 持续可见;④DESIGNS.md 按复案规则登记 T1-v2。
**教训⑬**:迁移功能时,"删旧位"是迁移的组成部分,不删=留孤儿=下一轮一定
被用户抓;⑭理解需求要确认到"哪个具体对象删除/保留",三轮才到位——每轮
都该先复述一遍理解再动手;⑮为既有实现辩护前,先问"它的存在本身对不对",
而不是"它是否忠于历史"。

---

## 2026-09-03 · 代码级自进化轮(DGM 桥)

**动机**:用户深度质问"自进化是各 agent 互相改底层代码,还是仅在提示词层面做文章?"
诚实盘点结论:此前进化=纯提示词层(技能 markdown 注入系统提示词,记忆检索注入),
**永远不改代码**。这不是 DGM 意义上的自进化。

**落地**(patches.ts,evolve.ts 步骤 6.5):
- proposePatches:元模型读会话信号+最热工具源码,提 ≤1 个 find/replace 补丁
- isPatchableFile 硬守卫:只允许 `packages/.../src/*.ts`;**永禁 kernel loop/provider**
  (自举悖论:改坏循环=智能体永久瘫痪)/config/security
- 沙箱周期:创建隔离 git 分支 → **补丁在分支上提交**(实测抓到的真 bug:不提交则
  checkout main 时未提交改动会漂移) → 全链 build + 双样本 bench → 过门合并/回归回滚
  (checkout main + hard reset + 删分支,零残留)
- 红线更新(CONTRIBUTING):进化写 skills/+memory/+可提代码补丁,四条件同时满足

**实测**(sandbox-e2e.test.ts):临时 git 仓跑完整周期,merge 路径(补丁落 main+分支删)
与 revert 路径(main 完好+树净+零残留)全部实证。

**教训**:用户问"所有修改你都验证过了吗"——诚实回答暴露了端到端缺口;写测试当场
抓到"补丁未提交"真 bug。**门禁绿 ≠ 行为对;新功能收工前必问:这条代码路径真的
从头到尾跑过一次吗。**

---

## 2026-09-02~03 · 智能体内核成熟轮(三轮实战审计)

**动机**:用户提供三份完整运行记录(freellmapi 配置 25 轮 71 万 token / 工具安装 /
新闻查询),逐份审计,证据驱动修根因。

### 第一轮:环境事实与反馈通道
- 根因①:模型不知道宿主是 cmd.exe——40+ 次 grep/head/wmic 失败。修复:系统提示词
  注入宿主事实(平台/shell 身份/等价命令速查/探测优先/禁全盘扫/失败两次换策略)
- 根因②:工具失败模式随会话丢失。修复:失败模式自动入长期记忆
- freellmapi 拒 Bearer 只认 X-Api-Key(实测同 key 两头对照)→ chat()/chatVision() 401
  自动重协商 + authHeader 字段

### 第二轮:提示词不够,硬墙来补
- 模型重复同一失败 curl 10 次(Unix 管道 6 次)——提示词已告但惯性无视 → 工具层硬墙:
  unixPipeOnWindows 预检(只查宿主段首词,容器内 Unix 词不误拦)+ 重复失败第 3 次短路
- DENY 误报:单文件 del 被硬拒 → 精度分级(单文件放行/递归删只拒盘根+系统目录+家目录)
- `npx skills add` 断头路(装别的 agent 格式)→ `hmh skills add`(三种布局,实测装 8 个 gsap 技能)

### 第三轮:结构化能力补全(用户批"只是修修补补,不是底层重构")
- Web 跨任务连续对话记忆(此前 Web 每任务失忆,REPL/TUI 却有)
- web_search(零 key DuckDuckGo)+ web_fetch(URL→可读文本)
- 输出人本化:工具流折叠一行可展开,AI 回答为主体(Claude Code 信噪分离)
- 内核并行工具执行:审批串行保序+执行并发(4×150ms 慢工具 ~1x 而非 4x,计时单测)
- **三层即时反馈**(用户批"8 轮才洞察太滞后"):Tier1 系统级错阈值 2→1 即记 /
  Tier2 每出错任务完成即一次小模型反思入记忆(下任务即受益)/ Tier3 进化轮 8→3
- 审批根因修复(用户实测抓到:自动模式仍弹窗——远程审批钩子无条件挂载覆盖 yes 标志)
- YOLO 三端(web 三档+TUI/REPL /yolo+CLI --yolo);状态行迁输入框上方带模式徽标
- 桌面自动化三件套 desktop_screenshot/click/type(看→动→验,PS here-string 在
  -Command 内联会炸的坑:改 Add-Type -MemberDefinition)
- 浏览器自动化:Windows 无头输出全空(平台限制,4 种参数组合实测)→ 诚实路线
  browser_open 可见浏览器+桌面三件套(实测 281KB 真实渲染)
- 会话管理:重命名(titles 映射,审计 jsonl 不可变)/归档/删除(trash 可恢复)
- i18n 守门:页面 L.引用 vs zh/en **双字典分别**校验;TUI COMMANDS 对称检查
  (undefined 事件的根治:缺键=构建失败)

**教训**:①提示词防线对模型习惯性行为不够,关键约束必须工具层硬执行;
②e2e 实测要选"可见范围"内的目标(列表截断 50 条,最老的在 API 视野外);
③JSDoc 里 `packages/*/src/` 的 `*/` 会提前终结块注释;
④`.cmd` shim 在现代 Node execFile 直 spawn 会 EINVAL。

---

## 2026-09-01~02 · 双前端对标与官网轮

- Web 三栏(deepseek-harness 式)+ 工作区实体(切换=服务端 chdir+会话按 cwd 分组)
  + 目录选择器(盘符/面包屑)+ /model 运行时路由切换 + providers 探测(env+opencode+本地网关)
- hmh tui 全屏重写(Claude Code 式:备用屏/斜杠面板 ↑↓ 选择/宽度感知输入框换行)
  ;原生拖选复制与滚轮共存(默认零鼠标上报,滚轮经终端转 ↑↓)
- YOLO/审批/状态行;GSAP 全站动画(CDN 守卫降级);官网双语上线 ndtool.cn/hmharness/
  (旧路径 301)
- 旧线退役:codelin/harmony-harness 资产甄别归档→本地+远程清除;实战 insights 并入长期记忆

---

## 2026-08-28 之前 · Phase 0-3 + 加固 + 模拟器自治

见 docs/ROADMAP.md 各 Phase 节与 docs/ARCHITECTURE.md(四包起步→七包、MCP、
进化循环、参数化脚手架、模拟器无头全生命周期、CI、多厂商路由)。
