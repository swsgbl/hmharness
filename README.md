# hmharness

**涓洪缚钂?HarmonyOS/OpenHarmony)寮€鍙戝叏娴佺▼鑰岀敓鐨勮嚜杩涘寲鏅鸿兘浣撴鏋躲€?* 闆朵緷璧栧唴鏍?+ 鑷繘鍖栦竴绛夊叕姘?+ MCP 鐢熸€佸€熷姏鈥斺€斾笉缁ф壙浠讳綍涓婃父杩愯鏃?鑳藉姏鍏ㄩ儴鑷寔鎴栫粡鏍囧噯鍗忚澶栧€熴€?
[English](README.en.md) · [![ci](https://github.com/swsgbl/hmharness/actions/workflows/ci.yml/badge.svg)](https://github.com/swsgbl/hmharness/actions/workflows/ci.yml)
![node](https://img.shields.io/badge/node-%3E%3D22-339933)
![deps](https://img.shields.io/badge/runtime%20deps-0-000000)

## 鐗规€т竴瑙?
| 棰嗗煙 | 鑳藉姏 |
|---|---|
| **鏅鸿兘浣撳唴鏍?* | while 寰幆鍐呮牳銆佷换鎰?OpenAI 鍏煎鍘傚晢銆佹祦寮忚緭鍑?鎬濊€冨潡銆佷笂涓嬫枃棰勭畻鍘嬬缉銆佸唴鏍哥骇瀹℃壒闂ㄧ銆佽拷鍔犲紡浼氳瘽瀹¤ |
| **楦胯挋鍘熺敓鍩?* | 宸ョ▼鑴氭墜鏋?鍙傛暟鍖?澶氶〉闈?澶氭ā鍧?涓€鍙ヨ瘽寤轰换鎰忕粨鏋?銆乭vigor 鏋勫缓銆乭dc 瀹夎/鍚姩/鏃ュ織/鍗歌浇銆佷粨棰?cjpm 鏋勫缓銆乧odelinter銆?*妯℃嫙鍣ㄥ叏鐢熷懡鍛ㄦ湡绠＄悊(鏃?IDE)** |
| **鑷繘鍖?* | 杩涘寲寰幆(娲炲療鎸栨帢鈫掕捣鑽夆啋璁粌/淇濈暀鍙岄泦闂ㄧ鈫掓檵鍗?鍥炴粴)銆佹妧鑳戒笁鎬佺绾裤€佹绱㈠紡闀挎湡璁板繂銆佸畾鏃惰繘鍖栥€佽繘鍖栧璁℃棩蹇?|
| **鐢熸€佸€熷姏** | MCP 瀹㈡埛绔?stdio+HTTP,5800+ 绀惧尯鏈嶅姟鍣ㄥ嵆鎻掑嵆鐢?銆乬h CLI 杩愮淮绠″(鐢熸€侀浄杈?issue 娴?AI 鍙捣鑽?浜烘壒鍑嗘墠鍙戝竷) |
| **澶氭櫤鑳戒綋** | spawn_agent 瀛愪唬鐞?鍏ㄦ柊涓婁笅鏂囥€佹繁搴︿笂闄愩€佸叡浜鎵广€佸璁″墠缂€) |
| **瑙嗚** | see_image(浠绘剰瑙嗚妯″瀷,澶氭彁渚涘晢闄嶇骇閾? |
| **澶氬墠绔?* | CLI / REPL / 杞婚噺 TUI(鏂滄潬鍛戒护)/ Web(娴忚鍣ㄦ祦寮?杩滅▼瀹℃壒+浼氳瘽鍥炴斁) |
| **鍥介檯鍖?* | zh / en 鍙岃鐣岄潰涓庣郴缁熸彁绀?|

## 蹇€熷紑濮?
```bash
git clone https://github.com/swsgbl/hmharness.git
cd hmharness
npm install
npm run build\nnpm link -w @hmh/cli   # 之后任意目录直接 hmh ...\nhmh init                    # 寤虹珛 ~/.hmharness(閰嶇疆+鐘舵€佺洰褰?
```

閰嶇疆浠绘剰 OpenAI 鍏煎鍘傚晢(缂栬緫 `~/.hmharness/config.json` 鎴栫幆澧冨彉閲?`HMH_BASE_URL / HMH_API_KEY / HMH_MODEL`):

```json
{
  "provider": { "baseUrl": "https://api.example.com/v1", "apiKey": "sk-...", "model": "your-model" }
}
```

澶氬巶鍟嗘寜鐢ㄩ€旇矾鐢?鍙€?:

```json
{
  "providers": {
    "a": { "baseUrl": "...", "apiKey": "...", "model": "strong-model" },
    "v": { "baseUrl": "...", "apiKey": "...", "model": "vision-model" }
  },
  "routing": { "chat": "a", "vision": "v", "evolve": "a" }
}
```

## 甯哥敤鍛戒护

```bash
npx hmh "浣犵殑浠诲姟"            # 涓€娆℃€т换鍔?瀹屾暣鏅鸿兘浣撳惊鐜?娴佸紡)
npx hmh                        # 浜や簰 REPL(璺ㄨ瀵硅瘽璁板繂)
npx hmh tui                    # 杞婚噺 TUI(鐘舵€佸ご+鏂滄潬鍛戒护)
npx hmh web [--port=7788]      # Web 鍓嶇(娴忚鍣ㄥ鎵?浼氳瘽鍥炴斁)
npx hmh resume [id鍓嶇紑]        # 缁х画鍘嗗彶浼氳瘽
npx hmh tools | mcp            # 宸ュ叿娓呭崟 / MCP 鏈嶅姟鍣ㄧ姸鎬?npx hmh check | devices        # 宸ュ叿閾句綋妫€ / 璁惧鍒楄〃
npx hmh evolve [--every=30]    # 鑷繘鍖栧惊鐜?鍗曟鎴栧父椹?
npx hmh bench | skills         # 鍩哄噯 / 鎶€鑳藉簱
npx hmh ops scan|brief|status  # 鐢熸€侀浄杈?```

鍗遍櫓鎿嶄綔榛樿璧板鎵归棬绂?TTY 寮?y/N;闈炰氦浜掗粯璁ゆ嫆缁?`--yes` 鎴?`"approval":"auto"` 鏀捐),鐮村潖鎬у懡浠ゆā寮忕‖鎷掋€?
## 楦胯挋鍏ㄦ祦绋?闆?IDE)

```text
harmony_project_create(pages+modules) 鈫?harmony_build 鈫?harmony_install
  鈫?harmony_launch 鈫?harmony_logs           # 鐪熸満/妯℃嫙鍣?harmony_emulator_list|catalog|create|start|stop|delete   # 妯℃嫙鍣ㄥ叏鐢熷懡鍛ㄦ湡
harmony_cjpm_build/test 路 harmony_lint                   # 浠撻 / codelinter
```

宸ョ▼鑴氭墜鏋跺畬鍏ㄥ弬鏁板寲:涓€娆¤皟鐢ㄧ敓鎴愬椤甸潰 + feature HAP + har 搴撶殑浠绘剰缁撴瀯;妯℃嫙鍣ㄧ鐞嗙洿鎺ラ┍鍔ㄥ畼鏂规棤澶?CLI,鏃犻渶鎵撳紑 DevEco Studio銆?
## 鑷繘鍖?
`hmh evolve` 涓€杞惊鐜?璇讳細璇濇礊瀵?鈫?鍏冩ā鍨嬭捣鑽夊€欓€夋妧鑳?鍐欏叆 drafts)鈫?**璁粌闆?* A/B 闂ㄧ(鍥炲綊鍗虫嫆)鈫?鏅嬪崌(鑷姩蹇収)鈫?**淇濈暀闆?*澶嶉獙(闃茶儗棰?鍥炲綊鍗冲洖婊?鈫?璁板繂钂搁(鍙涓嶅垹)鈫?鍏ㄧ▼钀?`evolution/log.jsonl`銆傚畨鍏ㄧ害鏉?杩涘寲寰幆鍙啓 `skills/` 涓?`memory/`,鏃犳硶瑙︾閰嶇疆涓庡畨鍏ㄨ缃€?
## 浠撳簱缁撴瀯

```
packages/
  kernel/          闆朵緷璧栧唴鏍?娉ㄥ唽琛峰惊鐜锋彁渚涘晢路浼氳瘽路閰嶇疆路鍘嬬缉路MCP 瀹㈡埛绔?
  evolution/       璁板繂路娲炲療路鎶€鑳戒笁鎬伮峰熀鍑?璁粌/淇濈暀)路杩涘寲寰幆
  domain-harmony/  楦胯挋鍩?璁惧路宸ュ叿閾韭疯剼鎵嬫灦路鏋勫缓路瀹夎路杩愯路鏃ュ織路浠撻路lint路妯℃嫙鍣?
  domain-ops/      杩愮淮绠″(鐢熸€侀浄杈韭穒ssue 娴?
  agent/           鎵ц灞?鍩虹宸ュ叿路绯荤粺鎻愮ず路spawn路runner)
  cli/  web/       缁堢涓庢祻瑙堝櫒鍙屽墠绔?鍚屼竴浜嬩欢鍗忚)
```

璇﹁ [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 涓?[docs/ROADMAP.md](docs/ROADMAP.md)銆?
## 鍙備笌璐＄尞

`npm run typecheck && npm test && npm run build` 鍏ㄧ豢鍗冲彲鎻愪氦;PR 涓€寰?draft 妯″紡銆傝瑙?[CONTRIBUTING.md](CONTRIBUTING.md)銆?
## 璁稿彲

[MIT](LICENSE)
