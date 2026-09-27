# KaihongOS / OpenHarmony 板端安装与踩坑指南

> EN TL;DR — This page documents running `@hmharness/cli` directly on a
> KaihongOS (OpenHarmony 5.0) board: no npm, no Python, read-only rootfs,
> isolated tmpfs mount-namespace terminals. One command installs everything:
> ```bash
> node scripts/install-kaihongos.cjs   # Node >= 22 required (any location)
> ```
> Then put your keys in `/data/local/home/.hmharness/config.json`
> (presets: [PROVIDERS.md](PROVIDERS.md)) and run `hmh tui`.

在深开鸿（KaihongOS，OpenHarmony 5.0，x86_64）电脑/板端上**原生**运行 hmharness
的完整指南。核心理念：**不装 npm、不动系统包，一条命令装完，填上密钥就能用。**

实测环境：KaihongOS 5.0 · x86_64 · Node v24.19.0 · busybox 1.37 · `@hmharness/cli` 0.18.12。

## 一键安装

```bash
# 前提：板上有任意 Node >= 22（DSH 自带的也行，路径无所谓，脚本自己找）
node scripts/install-kaihongos.cjs            # 装最新版（从 npm registry 拉包）
node scripts/install-kaihongos.cjs --bin-only # 只修复启动器（不下载）
```

安装器做五件事，每件都对应下面一条"坑"：

1. 找到可用的 Node ≥ 22（当前进程 / `dsh-pack/node` / `.ohos/node` / PATH）；
2. 从 registry.npmjs.org 解析 `@hmharness/*` 版本集（断网时退回内置已知良好版本）；
3. 下载 10 个官方 tarball，解包到 `/data/local/home/.local/hmharness/node_modules`
   （暂存 → 校验 → 原子切换，旧版本保留为 `node_modules.bak`）；
4. 生成加固启动器并装到**三个位置**（见坑 3/4）；
5. 首次运行自动执行 `hmh init` 建立状态目录和空白配置（绝不覆盖已有配置）。

装完只有一步人工操作——填密钥：

```bash
vi /data/local/home/.hmharness/config.json    # 模板已生成；38 家厂商预设见 docs/PROVIDERS.md
hmh check                                     # 工具链自检
hmh tui                                       # 或 hmh web start → http://127.0.0.1:7788
```

## 踩坑清单（每条都是真实踩过的）

### 坑 1：板端没有 npm，也没有 Python

`npm install -g` 直接不可用——KaihongOS 不带 npm，也无法在线装包。

**对策**：vendor 安装。`@hmharness/*` 十个包都是零第三方运行时依赖的
官方 tarball，用 Node 核心模块（`https`）下载 + busybox tar 解包即可，
完全不需要 npm。安装器内置了断网重试与已知良好版本回退。

### 坑 2：Node 不在 PATH 上

板上确实有 Node，但藏在工具目录里（如 `/data/local/home/dsh-pack/node/bin/node`），
裸 shell 敲 `node` 是 not found。

**对策**：安装器自己搜索候选路径；生成的启动器同样带搜索链，
`hmh` 永远通过绝对路径调 Node，与调用者的 PATH/HOME 无关。

### 坑 3：根文件系统只读（ext4 ro）

`/` 是真实 ext4 分区但挂载为只读，直接往 `/usr/local/bin` 写文件会 EROFS。

**对策**：`mount -o remount,rw /` → 写入 → `mount -o remount,ro /`。
写进去的文件在磁盘上持久，重启后 init 重新挂 ro 也不影响。
注意：**没有 dm-verity**（`/dev/block/vda2` 直接挂载，无 dm 设备），
所以这是安全的；若你的板有 verity，请只用 `~/.local/bin` + PATH 方案。

### 坑 4：部分终端/服务运行在独立挂载命名空间里，看不到 /usr（最大的坑）

KaihongOS 上系统服务（media_service、softbus_server 等）以及**从它们派生的
终端**（如某些 ttyd web 终端配置）运行在独立的 tmpfs 挂载命名空间：

- 它的 `/` 是一个 tmpfs（内存盘），**根本没有 `/usr`**；
- 只有 `/system/bin`、`/system/lib` 等从真实分区**只读 bind-mount** 进来；
- `/data` 完整可见；
- `/bin → /system/bin`（符号链接）；
- 这类 shell 通常连 `PATH` 变量都没有，mksh 用默认路径
  `/usr/local/bin:/bin:/usr/bin`。

所以装在 `/usr/local/bin/hmh` 的启动器，这种终端**永远**找不到
（`hmh: inaccessible or not found`），而 `/data` 里的文件它却看得见。
注意同一个 ttyd 重启后可能换回主命名空间——是否隔离取决于派生它的父进程，
所以不能依赖"碰巧在主空间"。

**对策**：把启动器同时装到 `/system/bin/hmh` —— bind-mount 是同一块
文件系统，宿主侧写入立刻对命名空间内可见；命名空间内 `/bin/hmh`
经符号链接解析成功，默认 PATH 命中。**这是唯一对两类终端都生效的位置。**

诊断命令（宿主侧）：对比 `readlink /proc/<ttyd-pid>/ns/mnt` 与
`readlink /proc/self/ns/mnt`；再看 `ls /proc/<ttyd-pid>/root/usr/local/bin/`。

### 坑 5：用户 shell 的 HOME=/

板端裸 shell 的 HOME 是 `/`（只读），hmh 默认把状态写到 `~/.hmharness`
就会失败或写到不可持久的位置。

**对策**：启动器强制 `HMH_HOME=/data/local/home/.hmharness`、
`HOME=/data/local/home`（仅当外部未显式设置时），状态与配置全部落在
可写分区。`hmh init` 生成的骨架也随之落在正确位置。

### 坑 6：密钥配置——装完就能用

密钥只存在本机 `config.json`（贡献红线：仓库里绝不放密钥）。板端推荐流程：

```bash
node scripts/install-kaihongos.cjs   # 首次运行自动 hmh init 生成模板
vi /data/local/home/.hmharness/config.json
```

```json
{
  "provider": { "baseUrl": "https://api.example.com/v1", "apiKey": "sk-...", "model": "your-model" },
  "providers": { "strong": { "baseUrl": "...", "apiKey": "...", "model": "..." } },
  "routing": { "chat": "strong", "evolve": "strong", "bench": "strong" },
  "maxTurns": 25
}
```

也支持环境变量 `HMH_BASE_URL / HMH_API_KEY / HMH_MODEL`；板上多密钥可放
`/data/local/home/.config/apikeys.env`，启动器会自动 source（可选，非必需）。

### 坑 7：鸿蒙工具链残缺

`hdc` 板上有；`hvigorw`/`ohpm` 没有；`cjpm`（仓颉）没有。

**对策**：`hmh check` 对 cjpm 本来就是"按可用性降级"，缺失不阻塞。
要完整构建能力，做一个 DevEco 布局的 shim 目录并设
`HM_DEVECO_HOME=/data/local/home/.local/hm-devtools`
（内含 `tools/hvigor/bin/hvigorw`、`tools/ohpm/bin/ohpm` 指向真实工具）。
启动器发现该目录存在会自动导出。

### 坑 8：JIT 被环境变量禁用

某些沙箱配置会给 Node 注入 `--jitless`（NODE_OPTIONS），板端 root shell
明明可以 JIT，禁掉会明显拖慢。

**对策**：启动器主动剔除 `--jitless` 并设 `NODE_ALLOW_JIT=1`。

### 坑 9：网页端端口被"幽灵进程"占用

`hmh web` 报 `port 7788 is already in use` 但 `web.pid` 里的进程已死——
真正的监听者是更早的孤儿 daemon（pid 文件与实际监听者脱节）。

**对策**：0.18.12 起 `hmh web status` 能识别；顽固占用时宿主侧
`for pid in $(ls /proc | grep -E '^[0-9]+$'); do ls -l /proc/$pid/fd 2>/dev/null | grep -q "socket:\[<inode>\]" && echo $pid; done`
（inode 从 `/proc/net/tcp` 端口十六进制行取）找到后 kill。
日常一律用 `hmh web start / stop / status`，不要手动 nohup。

## 卸载 / 更新

```bash
node scripts/install-kaihongos.cjs            # 更新到最新（旧版自动保留为 .bak）
rm -rf /data/local/home/.local/hmharness      # 卸载本体
mount -o remount,rw / && rm -f /system/bin/hmh /usr/local/bin/hmh && mount -o remount,ro /
```
