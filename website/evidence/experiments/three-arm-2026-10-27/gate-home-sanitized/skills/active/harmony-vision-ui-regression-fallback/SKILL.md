# Harmony Vision UI Regression Fallback

Use when `harmony_ui_regression` returns FAIL or a can't-view-image message for a page you expect to render text.

1. Check the run-time vision provider routing.
   - In kernel/src/types.ts the `routing.vision` key overrides the `vision` block.
   - Ensure the routed provider is image/vision-capable (for example glm-4.5v).
   - Config-only fix: set `providers['glm-vision']={model:'glm-4.5v',baseUrl:'https://open.bigmodel.cn/api/coding/paas/v4'}` and `routing.vision='glm-vision'`.
   - No restart needed: `loadConfig()` re-reads per tool call.

2. Retry with the saved screenshot path.
   - On Windows, avoid inline payloads for 100KB+ vision requests.
   - Use `curl --data-binary @payload.json` with a JSON file, or pass the local screenshot path to `harmony_ui_regression`.

3. Confirm ground truth with hdc layout dump.
   - `hdc -t <target> shell uitest dumpLayout -p /data/local/tmp/layout.json`
   - `hdc -t <target> file recv /data/local/tmp/layout.json .`
   - Search the JSON for node `text` / `originalText` values to confirm or refute the visual verdict.

4. Only mark FAIL when both vision and `uitest dumpLayout` agree; a provider that cannot view images is a tooling defect, not a UI failure.