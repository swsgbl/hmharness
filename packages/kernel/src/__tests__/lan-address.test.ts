/**
 * Which address the phone is sent to (2026-11-27). The shapes below are the
 * ones real machines present; addresses are 10.x / 172.x because the repo's
 * push hook refuses 192.168.x.x in committed files.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as kernel from '../lan-address.ts';

type Info = { address: string; family: string; internal: boolean; mac?: string; cidr?: string; netmask?: string };
const v4 = (address: string, internal = false): Info => ({ address, family: 'IPv4', internal, mac: '00:00:00:00:00:00', netmask: '255.255.255.0', cidr: address + '/24' });
const v6 = (address: string): Info => ({ address, family: 'IPv6', internal: false, mac: '00:00:00:00:00:00', netmask: 'ffff:ffff:ffff:ffff::', cidr: address + '/64' });

const pick = (map: Record<string, Info[]>): string => (kernel as unknown as { pickLanAddress: (m: Record<string, Info[]>) => string }).pickLanAddress(map);

test('a proxy tunnel enumerated before the WiFi adapter never wins: the phone gets the WiFi address', () => {
  assert.equal(typeof (kernel as Record<string, unknown>).pickLanAddress, 'function');
  // the shape that sent the phone to 172.18.0.1 on 2026-11-26 (tunnel first, WiFi last).
  // Either rule alone rescues this one - the tunnel family is skipped, and the
  // WiFi adapter is preferred - so the family rule by itself is pinned by the next test.
  assert.equal(pick({
    'VMware Network Adapter VMnet8': [v6('fe80::1'), v4('10.161.0.1')],
    'vEthernet (WSL (Hyper-V firewall))': [v4('10.25.0.1')],
    singbox_tun: [v4('172.18.0.1')],
    Tailscale: [v4('100.64.0.1'), v6('fd7a:115c:a1e0::1')],
    WLAN: [v6('fe80::2'), v4('169.254.124.249'), v4('10.8.0.3')],
  }), '10.8.0.3');
});

test('every tunnel, container and VPN family is skipped, on each system\'s naming', () => {
  for (const name of ['singbox_tun', 'tun0', 'utun3', 'wintun', 'wg0', 'tailscale0', 'ZeroTier One', 'docker0', 'veth1a2b3c', 'br-3f2a1b', 'virbr0', 'cni0', 'vEthernet (Default Switch)', 'VMware Network Adapter VMnet1', 'VirtualBox Host-Only Network', 'tap-nordvpn', 'VPN Client - VPN Adapter', 'Tunnel adapter isatap.{1}', 'Bluetooth Network Connection', 'Loopback Pseudo-Interface 1']) {
    assert.equal(pick({ [name]: [v4('10.9.0.1')] }), '10.9.0.1', name + ' alone: the virtual address is still what gets printed');
    assert.equal(pick({ [name]: [v4('10.9.0.1')], 'Ethernet': [v4('10.10.0.2')] }), '10.10.0.2', name + ': a real adapter beats it');
  }
});

test('wireless is preferred over a cable, whatever the enumeration order; without one, the first real adapter', () => {
  const cable = { '以太网 2': [v4('10.20.0.5')] };
  const wifi = { WLAN: [v4('10.21.0.6')] };
  assert.equal(pick({ ...cable, ...wifi }), '10.21.0.6');
  assert.equal(pick({ ...wifi, ...cable }), '10.21.0.6');
  assert.equal(pick({ 'Wi-Fi': [v4('10.22.0.7')], ...cable }), '10.22.0.7');
  assert.equal(pick({ wlp3s0: [v4('10.23.0.8')], enp4s0: [v4('10.24.0.9')] }), '10.23.0.8');
  assert.equal(pick({ enp4s0: [v4('10.24.0.9')], eth1: [v4('10.25.0.10')] }), '10.24.0.9', 'first real adapter in enumeration order');
  assert.equal(pick(cable), '10.20.0.5');
});

test('loopback, IPv6, link-local and carrier-grade NAT addresses are never candidates; nothing prints as empty', () => {
  assert.equal(pick({ lo: [v4('127.0.0.1', true), v6('::1')], WLAN: [v6('fe80::a'), v4('169.254.1.1'), v4('100.64.0.9'), v4('100.127.1.2')] }), '');
  assert.equal(pick({}), '');
  assert.equal(pick({ WLAN: [] }), '');
});

test('a real adapter whose name merely contains the letters of a virtual family is not mistaken for one', () => {
  // "tun" inside a word, after a letter: a bare substring match would skip this adapter,
  // the word-ish match does not. (A name that STARTS with "Tun" matches both - that
  // fixture proved nothing, the mutation control caught it.)
  assert.equal(pick({ 'eth-retun0': [v4('10.30.0.1')] }), '10.30.0.1');
  // on its own the last-resort fallback returns it anyway: the mistake only shows
  // when another real adapter comes later in the enumeration
  assert.equal(pick({ 'eth-retun0': [v4('10.30.0.1')], enp4s0: [v4('10.32.0.3')] }), '10.30.0.1', 'still the first REAL adapter');
  assert.equal(pick({ 'eth-retun0': [v4('10.30.0.1')], WLAN: [v4('10.31.0.2')] }), '10.31.0.2', 'and it still ranks below a wireless adapter');
});
