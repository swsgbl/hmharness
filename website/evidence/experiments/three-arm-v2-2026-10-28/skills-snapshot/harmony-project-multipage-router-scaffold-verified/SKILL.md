# HarmonyOS multipage router scaffold verified

Use when creating a HarmonyOS project with multiple pages and router navigation, or when a router scaffold attempt fails verification.

## Steps
1. Check toolchain and devices:
   run_command: hvigorw --version
   run_command: hvigorw.bat --version
   run_command: hdc list targets
2. Create project from template if missing:
   Use DevEco Studio: File > New > Project > Empty Ability, or run the organization's project template command.
3. Add pages:
   write_file entry/src/main/ets/pages/Index.ets
   write_file entry/src/main/ets/pages/Detail.ets
4. Register route map:
   write_file entry/src/main/resources/base/profile/main_pages.json
   Content: {"src":["pages/Index","pages/Detail"]}
5. Add router call:
   import router from '@ohos.router';
   router.pushUrl({ url: 'pages/Detail' });
6. Verify paths before reading:
   run_command: list_dir entry/src/main/ets/pages
   run_command: list_dir entry/src/main/resources/base/profile
7. Build and schema check:
   run_command: hvigorw assembleHap --mode module -p product=default --no-daemon
   run_command: harmony_schema_check --project-path . --entry entry
8. Install and launch if device/emulator present:
   run_command: hdc install -r entry/build/default/outputs/default/entry-default-signed.hap
   run_command: hdc shell aa start -a EntryAbility -b com.example.myapp
9. Capture evidence:
   run_command: hdc shell snapshot_display -f /data/local/tmp/s.png
   run_command: hdc file recv /data/local/tmp/s.png ./s.png
10. If page not found, cross-check main_pages.json entries against file paths; use absolute paths for read_file and write_file.

## Windows pitfalls
- Use hvigorw.bat on Windows.
- Quote semicolon/bracket values in run_command, e.g. --providers '[;dist]'.
- Do not execute .md files; ensure run_command target is an executable script or shell command.
- Verify file existence before read_file to avoid ENOENT.
