# Network Preflight for HarmonyOS Tools

Before using HarmonyOS toolchain commands that involve remote devices or servers, check network connectivity to avoid failures.

## Steps

1. Identify the target device or server address from the task context.
   - Common targets: emulator IP (e.g., 127.0.0.1:5555), real device IP, or package registry.

2. Use `run_command` to test connectivity with a simple ping or equivalent.
   - Example: `ping -n 1 127.0.0.1` to check if emulator is reachable.
   - For HTTPS endpoints, use `curl` or `PowerShell Invoke-WebRequest` to test connection.

3. If connectivity fails, troubleshoot network settings, VPN (use vpn-manager skill if available), or device status.

4. Proceed with the intended toolchain command only after confirming connectivity.

## Example Commands

- `run_command(command: "ping -n 1 127.0.0.1")` for emulator check.
- `run_command(command: "hdc list targets")` to verify device list, which implies connectivity.

This preflight step saves time by catching network issues early.