# HarmonyOS Emulator State Ground Truth

## When to use
When checking if a HarmonyOS emulator is running/stopped on a Windows host, especially after DevEco Studio has been opened.

## Problem
DevEco Studio spawns a short-lived Emulator.exe probe every few seconds. Get-Process may show an Emulator process with a different PID each time, empty CommandLine, and it vanishes instantly. This is NOT a running emulator.

## Ground truth checks
1. Run `hdc list targets` in a shell. Empty output means no device/emulator is reachable.
2. Run the `harmony_emulator_list` tool and read the `state` field for each deployed instance.
3. A real emulator process command line contains `-hvd <instance-name>`. Use PowerShell to inspect only processes whose command line includes `-hvd`; ignore probes without it.
4. Do not kill Emulator.exe indiscriminately; the probe will respawn and killing it is wasted effort.

## Deployed instance locations (this host)
- Instances and lists.json: `%LOCALAPPDATA%\Huawei\Emulator\deployed`
- System images: `%LOCALAPPDATA%\Huawei\Sdk\system-image`
- Configs: `%LOCALAPPDATA%\Huawei\Emulator6.1\.emu_config` and `Emulator26.0\.emu_config`

## Start/stop verification example
1. `harmony_emulator_start` with the desired instance name.
2. Immediately run `hdc list targets` until the target appears (e.g. `127.0.0.1:5555`).
3. Use `harmony_devices` or `hdc shell` to confirm the device is responsive.
4. Stop with `harmony_emulator_stop` and verify `hdc list targets` returns empty.
5. A full cold kill of Emulator.exe plus restart should preserve the deployed instance state on disk.