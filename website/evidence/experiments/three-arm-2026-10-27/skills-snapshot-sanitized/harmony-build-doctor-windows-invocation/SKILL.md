Do not retry the bare harmony_build_doctor command on Windows; it may return no parseable output.
Use `flutter pub run harmony_build_doctor` from the project root.
Always capture stdout/stderr to a log file and check the exit code immediately after the command; do not treat no output as success.
Example commands:
  cd /d G:\hmharness-selffeed\SelfFeedR
  flutter pub run harmony_build_doctor > doctor_out.txt 2>&1
  echo EXITCODE=%ERRORLEVEL% & more doctor_out.txt
  findstr /n "✓ ✗" doctor_out.txt
To summarize, report each doctor check health from the captured output and preserve evidence (command, exit code, log file, screenshot if UI).
If output is empty but exit code is 0, instrument and repeat with explicit redirection; if no Flutter, fall back to the direct DevEco/toolchain command path and capture output similarly.