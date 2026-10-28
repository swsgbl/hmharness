# DevEco Studio Windows Major Upgrade Migration

Use when moving from one major DevEco Studio to another on Windows (e.g. 6.1.1.268/API24 to 26.0.0.821/API26) and projects must keep building.

## 1. Locate installed versions
Old NSIS install example: `C:\DevEco-Studio` (DS-243, 6.1.1.268). New example: `C:\Program Files\Huawei\DevEco Studio` (DS-261, 26.0.0.821). Run `list_dir` first; never assume paths.

## 2. Silent uninstall old version
Do NOT use GUI overwrite/upgrade. NSIS installers support:
cmd
"C:\DevEco-Studio\bin\Uninstall.exe" /S

`--mode unattended` is not honored and will block on GUI. Deletion completes asynchronously in 1-2 minutes.

## 3. Switch user environment variables
cmd
setx DEVECO_HOME "C:\Program Files\Huawei\DevEco Studio"
setx DEVECOSTUDIO_HOME "C:\Program Files\Huawei\DevEco Studio"
setx HVIGOR_HOME "C:\Program Files\Huawei\DevEco Studio\tools\hvigor"
setx NODE_HOME "C:\Program Files\Huawei\DevEco Studio\tools\node"
setx OHPM_HOME "C:\Program Files\Huawei\DevEco Studio\tools\ohpm"
setx OHOS_SDK_HOME "C:\HarmonyOS-SDK-6.1.1-api26"
setx DEVECO_SDK_HOME "C:\HarmonyOS-SDK-6.1.1-api26"

Update `PATH` to the new `bin`, `tools\node`, `tools\hvigor\bin`, `tools\ohpm\bin`.

## 4. Keep old SDK for rollback
Old API24 SDK stays at `C:\HarmonyOS-SDK-6.1.1-api24`. New API26 SDK can build projects with `compatibleSdkVersion 6.1.1(24)` (confirmed BUILD SUCCESSFUL). Switch `OHOS_SDK_HOME` only after verifying.

## 5. Preserve old IDE config
Keep `%APPDATA%\Huawei\DevEcoStudio6.1` and `%LOCALAPPDATA%\Huawei\DevEcoStudio6.1` for rollback.

## 6. Verify
Run `harmony_toolchain_check`, then build a representative project:
cmd
hvigorw assembleHap --mode module -p product=default --no-daemon

Confirm `BUILD SUCCESSFUL`. If it picks the wrong SDK, inspect `OHOS_SDK_HOME`/`DEVECO_SDK_HOME` and restart the shell before retrying.
