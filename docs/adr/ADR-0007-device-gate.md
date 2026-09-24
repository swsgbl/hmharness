# ADR-0007: Device Gate — V3 第二切片

日期: 2026-09-13 · 状态: 已实施（0.11.0）

## 背景

ADR-0006 明确"Emulator/Device 阶段属 V3 后续切片"。V3 DoD 链里 Build→
Emulator/Device→Test 是把"代码看起来对"升级为"设备上真跑"的关键环节。
模拟器（hdc 127.0.0.1:15555/5555）在本机可用；M6 已验证 runDeviceTest
（install/launch/log-marker/uninstall 四步）端到端工作。

## 决策

1. **deviceGate 是机械证据采集器，不是 LLM 阶段**（ADR-0006 顺序原则）：
   `runPipeline({ deviceGate })` 给出 hdc 路径与目标包信息时，pipeline 在
   test 阶段完成后调用 runDeviceTest，四步结果（install/launch/log-marker/
   uninstall-cleanup）原样进 stages（stage: 'device'，verdict 由全步 PASS
   与否决定）并注入 judge 的证据摘要。
2. **失败语义**：任一步 FAIL → 该 pipeline 的 judge 证据里带"DEVICE GATE
   FAILED: <step> <detail>"，但**是否 FAIL 由 judge 依据全部证据裁决**——
   设备未连接（install 前置失败）不等于代码错误；机械层只负责让证据可见。
3. **预算**：deviceGate 是纯命令执行（不耗模型轮次），但计入 wall time；
   四步各自有 execFile 超时（120s/30s/轮询 6s/60s），无失控路径。
4. 骨架不变：五角色 + repair 循环 + 硬预算阀全部沿用。

## 后果

- `hmh pipeline` 新增 `--device=<hdc 路径>`（默认探测 hdc）时启用设备门。
- 回滚：纯增量（deviceGate 选项 + 一个 stage 类型），删除即回 0.10.0。
