# HarmonyOS UI Layout Ground Truth

Use `hdc uitest dumpLayout` to get the view tree JSON when `see_image` or `harmony_ui_regression` gives uncertain/negative results.

## When to use
- `harmony_ui_regression` reports FAIL but you suspect a false negative.
- You need text-level proof that a page rendered its title or content.

## Steps
1. List device targets:
   `hdc list targets`
   or use `harmony_devices` in this framework.
2. Dump layout on device:
   `hdc -t <target> shell uitest dumpLayout -p /data/local/tmp/layout.json`
3. Pull the file:
   `hdc -t <target> file recv /data/local/tmp/layout.json ./layout.json`
4. Inspect JSON for `pagePath`, node `text`, `originalText`, `bounds`, `opacity`.
5. Assert the expected title/content appears; use this to confirm or refute vision-model verdict.

## Example

hdc -t 127.0.0.1:5555 shell uitest dumpLayout -p /data/local/tmp/layout.json
hdc -t 127.0.0.1:5555 file recv /data/local/tmp/layout.json ./layout.json
read_file ./layout.json


## Notes
- Do not rely solely on `see_image`; a text-only vision provider can cause false-negative UI regression.
- This caught a false FAIL for com.example.selffeed2 pages/Index showing Text "Hello HarmonyOS".