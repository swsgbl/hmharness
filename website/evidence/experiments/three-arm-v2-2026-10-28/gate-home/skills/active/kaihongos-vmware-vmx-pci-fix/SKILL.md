## Symptom
- VMware VM fails to start or boot; log shows: 无法为 sata0 分配可用的 PCI 插槽.
- Hand-written .vmx has `*.pciSlotNumber = "-1"` pins and missing pciBridge entries.

## Fix
1. Edit the VMX, e.g. `E:\VMs\KaihongOS-5.0\KaihongOS.vmx`.
2. Delete every `*.pciSlotNumber = "-1"` line.
3. Add PCI root port bridges:
   
   pcibridge0.present = "TRUE"
   pcibridge0.virtualDev = "pcieRootPort"
   pcibridge0.functions = "8"
   pcibridge4.present = "TRUE"
   pcibridge4.virtualDev = "pcieRootPort"
   pcibridge4.functions = "8"
   
4. Set boot order:
   `bios.bootOrder = "cdrom,hdd"`
5. Start:
   `vmrun start "E:\VMs\KaihongOS-5.0\KaihongOS.vmx" nogui`
6. Check log:
   
   Get-Content "E:\VMs\KaihongOS-5.0\vmware.log" -Tail 50 | Select-String "sata0|pci"
   
   Expected: `sata0:0 CDROM` read activity. `CMD 0x52 FAILED` is normal EFI optical probe, not a fatal error.