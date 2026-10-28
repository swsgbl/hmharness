# Harmony Emulator State Triangulation

Use when any emulator/device state claim matters (start/stop/install/screenshot/UI verify). A single `hdc list targets` or emulator list can be stale, so rely on independent sources and record timestamps.

## Step 1: Collect raw state
Run all probes and save outputs:
- hdc list targets
- harmony_emulator_list
- PowerShell process check for qemu/emulator/HDC
- harmony_devices if available

Example:
run_command: hdc list targets
run_command: harmony_emulator_list
run_command: powershell -NoProfile -Command "Get-Process | Where-Object {$_.Name -match 'qemu|emulator'} | Select-Object Id,Name,StartTime | Format-Table -AutoSize"

## Step 2: Compare sources
- Device online only if both hdc target list and process list agree.
- If hdc shows a target but no qemu/emulator process, treat it as stale and re-probe.
- If process exists but no target, wait 5-10s and re-run hdc; do not restart blindly.

## Step 3: Verify side effects
After start:
run_command: hdc list targets
run_command: hdc shell param get const.product.model

After install/launch:
run_command: hdc shell aa start -a EntryAbility -b com.example.app
run_command: hdc shell hidumper -s WindowManagerService -a '-a'

## Decision table
hdc target | process | action
present | running | proceed
present | absent | re-probe; treat as stale
absent | running | wait/re-probe; check logs
absent | absent | start emulator, then Step 3

## Recording
Save outputs to files with timestamps. Do not claim started/stopped unless a post-action probe shows the desired state.