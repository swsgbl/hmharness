# HarmonyOS Device Screenshot Verification

Use when you need visual confirmation of an installed and launched HarmonyOS app.

## Steps
1. List connected targets with `harmony_devices`; if empty fall back to `hdc list targets`.
2. Pick the device/emulator target, e.g. `127.0.0.1:5555`.
3. Confirm the app is launched. If not, launch it first.
4. Capture a screenshot on-device:
   `hdc -t 127.0.0.1:5555 shell snapshot_display -f /data/local/tmp/ui.png`
5. Pull it to the worktree:
   `hdc -t 127.0.0.1:5555 file recv /data/local/tmp/ui.png ./ui.png`
6. Verify the file exists and is non-zero with `list_dir .`.
7. Inspect the image with `see_image ./ui.png`.
8. Check for expected UI elements, text, layout, and absence of black/blank screen.
9. If the screenshot is blank or stale, wait 1-2 seconds and retry; restart the app if needed.
10. Record findings with `remember`, including device target, bundle name, and screenshot path.

## Example commands

harmony_devices
hdc list targets
hdc -t 127.0.0.1:5555 shell snapshot_display -f /data/local/tmp/ui.png
hdc -t 127.0.0.1:5555 file recv /data/local/tmp/ui.png ./ui.png
list_dir .
see_image ./ui.png

