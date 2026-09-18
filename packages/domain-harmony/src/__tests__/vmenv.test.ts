import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parseHostfwd, parseVmrunList, resolveQemu, resolveVmrun, VM_DEFAULTS } from '../vmenv.ts';

test('parseHostfwd: extracts the guest-5555 forward port from a launch script', () => {
  const p = 'D:/OHOS-QEMU/KaihongOS/launch_qemu_vnc.cmd';
  if (existsSync(p)) {
    assert.equal(parseHostfwd(readFileSync(p, 'utf8')), 15565, 'real launch script on this machine');
  }
  assert.equal(parseHostfwd('-netdev user,hostfwd=tcp:127.0.0.1:15566-:5555'), 15566);
  assert.equal(parseHostfwd('no forwarding here'), VM_DEFAULTS.qemuHdcPort, 'fallback to default');
});

test('parseVmrunList: vmx lines only, trimmed, case-insensitive match', () => {
  const out = [
    'Total running VMs: 2',
    'D:\\VMs\\Ubuntu-26.04\\Ubuntu-26.04.vmx',
    'D:\\VMs\\Kali-2026.2\\KALI-2026.2.VMX',
    'C:\\some\\not-vm.txt',
    '',
  ].join('\r\n');
  assert.deepEqual(parseVmrunList(out), [
    'D:\\VMs\\Ubuntu-26.04\\Ubuntu-26.04.vmx',
    'D:\\VMs\\Kali-2026.2\\KALI-2026.2.VMX',
  ]);
});

test('resolveQemu/resolveVmrun: defaults + config overrides', () => {
  const d = resolveQemu();
  assert.equal(d.dir, VM_DEFAULTS.qemuDir);
  // default = the LIVE channel (15566 -> guest hdcd 10178, per the .lnk
  // launch variant); the vnc cmd's 15565 is an alternate script
  assert.equal(d.hdcPort, 15566);
  const c = resolveQemu({ dir: 'X:/q', hdcPort: 1234 });
  assert.equal(c.launchPath, 'X:\\q\\launch_qemu_vnc.cmd');
  assert.equal(c.hdcPort, 1234);
  const v = resolveVmrun({ vmDirs: ['E:/myvms'] });
  assert.deepEqual(v.vmDirs, ['E:/myvms']);
  assert.equal(resolveVmrun().vmrun, VM_DEFAULTS.vmrun);
});
