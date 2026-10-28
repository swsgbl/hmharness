# Sanitization

2026-10-29: archived run artifacts recorded the OS username in tmpDir/env paths (script now scrubs at write time — single choke point in the artifact writer). In-place replacement of the OS username literal with `<user>`; pre-image sha256 (first 16 hex) per file BEFORE scrub:

- `website/evidence/cleanroom/SANITIZATION.md` — `b333c9b07b28ee5f`
