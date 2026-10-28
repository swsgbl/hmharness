Use harmony_project_create from the framework; minimal params produce exactly 19 files, one page (Index), single entry HAP module, deviceTypes phone/tablet/2in1, SDK 6.1.1(24), vendor hmharness, and the bundle is lowercased from the directory/name.
To get extra pages, pass the explicit pages:[...] param (e.g. pages=Index,Detail). The default is NOT Index+Detail; a hand-added page needs both the .ets file and a main_pages.json entry.
Baseline build: first build ~7.558s, incremental ~6.371s; hap is 15446 B with 1 page and ~21976 B with 2 pages.
Definitive page-registry check: unpack the hap with Windows libarchive (`tar -xf x.hap`) and read resources/base/profile/main_pages.json.
Do NOT trust findstr on build/intermediates res/default/resources.index; that 773 B key index holds no raw page strings (even pages/Index is absent).
Example commands:
  harmony_project_create path=G:/hmharness-selffeed/SelfFeedN pages=Index,Detail
  harmony_build path=G:/hmharness-selffeed/SelfFeedN
  tar -xf SelfFeedN.hap -C hap_unpacked
  more hap_unpacked/resources/base/profile/main_pages.json
  echo EXITCODE=%ERRORLEVEL%
If the project is not a git repo, verify restores/modifications with `fc /b backup file` (exit 0 + no diff), not git status.