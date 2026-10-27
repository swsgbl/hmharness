# harmony_ui_regression False-Negative Vision Fix

`harmony_ui_regression` can silently FAIL because `routing.vision` has precedence over the `vision` config block. A text-only provider selected this way returns non-vision output.

## Root cause
In `kernel/src/types.ts:119`, `resolveProvider` gives `routing.vision` precedence. If that provider is text-only, `see_image` / `harmony_ui_regression` cannot view images and reports false FAIL.

## Fix (config only, no restart)
Add a working vision provider and point `routing.vision` at it:


{
  "providers": {
    "glm-vision": {
      "model": "glm-4.5v",
      "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4"
    }
  },
  "routing": {
    "vision": "glm-vision"
  }
}


## Verification
- Re-run the tool without restarting; config is re-read per tool call.
- `glm-4.5v` works domestically without proxy.
- Known bad routes: local freellmapi:3002 qwen-vl-max returns 429 "model lacks vision"; NVIDIA NIM times out even with VPN.

## If still in doubt
Use `hdc uitest dumpLayout` as vision-independent ground truth before concluding UI regression failed.