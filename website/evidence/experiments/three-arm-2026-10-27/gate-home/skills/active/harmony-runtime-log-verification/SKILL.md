# HarmonyOS Runtime Log Verification

Use after launching an app to check for crashes, errors, and lifecycle events.

## Steps
1. Identify the target with `harmony_devices` or `hdc list targets`.
2. If you know the bundle name, find its PID:
   `hdc -t 127.0.0.1:5555 shell pidof com.example.app`
3. Clear previous logs for a clean signal:
   `hdc -t 127.0.0.1:5555 shell hilog -r`
4. Perform the app action you need to verify.
5. Capture logs to a local file through `run_command`:
   `hdc -t 127.0.0.1:5555 shell hilog -x > ./hilog.txt`
6. Read the file with `read_file ./hilog.txt`.
7. Search for the bundle name, PID, `FATAL`, `ERROR`, `Exception`, and crash stack keywords.
8. If logs are large, capture before and after the action and compare relevant sections.
9. Record the error signature and next step with `remember`.

## Example commands

harmony_devices
hdc list targets
hdc -t 127.0.0.1:5555 shell pidof com.example.app
hdc -t 127.0.0.1:5555 shell hilog -r
hdc -t 127.0.0.1:5555 shell hilog -x > ./hilog.txt
read_file ./hilog.txt

