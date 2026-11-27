/**
 * The LAN address a phone on the same WiFi can actually reach
 * (2026-11-27; one implementation for the CLI banner and the web server,
 * which each carried a copy until then).
 *
 * os.networkInterfaces() lists every adapter, virtual ones included. Two
 * copies of the rule picked "the first private IPv4 whose adapter name does
 * not look virtual", and the list of virtual-looking names stopped at
 * Tailscale/VMware/WSL. On a machine with a proxy tunnel (singbox_tun,
 * 172.18.0.1) enumerated before the WiFi adapter, the banner sent the phone
 * to the tunnel's address. Tunnel, container and VPN adapters are named in
 * recognisable families, so the rule is: skip them by name, and among the real
 * adapters prefer a wireless one - a phone is on the WiFi, not on the cable.
 */
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

/** Adapter names of virtual machines, containers, VPN overlays and proxy
 *  tunnels: never where the user's phone is. Word-ish matches, so a real
 *  adapter whose name merely contains the letters is not caught. */
const VIRTUAL_NAME = /vmware|virtual|hyper-?v|vethernet|wsl|tailscale|zero ?tier|docker|podman|lxc|loopback|bluetooth|vbox|virtualbox|pseudo|vpn|wireguard|openvpn|wintun|utun|singbox|clash|mihomo|v2ray|xray|shadowsocks|veth|virbr|cni|tap|tunnel|(^|[^a-z])tun|(^|[^a-z])wg[0-9]|(^|[^a-z])br-[0-9a-f]+/i;

/** Wireless adapters as the systems name them: Windows (WLAN / Wi-Fi / 无线),
 *  macOS, Linux (wlp3s0, wlx…). */
const WIRELESS_NAME = /wi-?fi|wlan|wireless|802\.11|无线|airport|(^|[^a-z])wl[a-z]/i;

const isRfc1918 = (a: string): boolean => /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a);

/**
 * The best private IPv4 for reaching this machine from the local network:
 *  a wireless adapter first, then any other real adapter, and only when no
 *  real adapter has a private address at all, a virtual one (better than
 *  nothing to print). Empty when there is no candidate.
 *  `interfaces` is os.networkInterfaces()-shaped and injectable for tests.
 */
export function pickLanAddress(interfaces: Record<string, NetworkInterfaceInfo[] | undefined> = networkInterfaces()): string {
  let wired = '';
  let virtual = '';
  for (const [name, list] of Object.entries(interfaces)) {
    for (const n of list ?? []) {
      if (n.family !== 'IPv4' || n.internal || !isRfc1918(n.address)) continue;
      if (VIRTUAL_NAME.test(name)) { virtual = virtual || n.address; continue; }
      if (WIRELESS_NAME.test(name)) return n.address;
      wired = wired || n.address;
    }
  }
  return wired || virtual;
}
