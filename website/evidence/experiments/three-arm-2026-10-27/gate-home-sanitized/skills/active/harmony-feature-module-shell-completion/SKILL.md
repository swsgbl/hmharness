# Completing a harmony_project_create feature module

`harmony_project_create` with `modules:[{name:"login",type:"feature"}]` produces a bare feature HAP shell, not a routable feature page. Fill the known gaps before treating it as usable.

## What the tool creates
- `module.json5` with `type:"feature"` and `deliveryWithInstall:true`
- its own `build-profile.json5`, `hvigorfile.ts` (hapTasks), `oh-package.json5` (dependencies `{}`)
- one `resources/base/element/string.json` and one stub `<name>Api.ets`
- root `build-profile.json5` `modules[]` entry (`srcPath ./login`, default target)

## What it does NOT create
- No `pages` directory, no `main_pages.json` entry, no ability, and `oh-package.json5` may misleadingly claim `"main":"Index.ets"` while no `Index.ets` exists
- dependencies stay `{}`, so nothing is wired for cross-module navigation/sharing

## Completion steps
1. Create the page:
   mkdir -p login\src\main\ets\pages
   write_file login\src\main\ets\pages\LoginPage.ets with `@Entry @Component struct LoginPage`
2. Register the page in `login\src\main\resources\base\profile\main_pages.json`:
   [ "pages/LoginPage" ]
3. Add an ability in `login\src\main\module.json5` only if this module should actually launch; otherwise treat it as a delivery package and do not expect a routable page.
4. Wire dependencies explicitly in the consuming `oh-package.json5` if shared code is needed. Prefer HSP (shared package) or HAR for shared routable code; a feature HAP shell is deliveryWithInstall packaging, not a shared page module.

## Verification
1. `cd /d G:\hmharness-selffeed\SelfFeedM` and run `harmony_schema_check` -> green.
2. `hvigorw assembleHap --no-daemon` -> both `:entry:assembleHap` and `:login:assembleHap` succeed, producing two unsigned HAPs.
3. Unpack the produced HAP and inspect `resources/base/profile/main_pages.json` to confirm `pages/LoginPage` is present.
4. Optional runtime check with `harmony_install` / `harmony_launch` when a device/emulator is available.

## Gotcha
- `"main":"Index.ets"` is dangling until you actually create that file; it does NOT prove a page exists.