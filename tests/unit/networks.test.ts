import { describe, it, expect } from 'vitest';
import {
  isValidHttpUrl,
  allNetworks,
  getNetworkDef,
  isPresetNetwork,
  networkIdFromName,
  toNetworkInfo,
  networkInfoList,
  activeNetworkInfo,
  PRESET_NETWORKS,
  type CustomNetworkDef,
} from '../../src/wallet/networks';

describe('isValidHttpUrl (webcli is_valid_http_url parity)', () => {
  it('accepts http/https with a host', () => {
    expect(isValidHttpUrl('https://octra.network/rpc')).toBe(true);
    expect(isValidHttpUrl('http://127.0.0.1:9494')).toBe(true);
    expect(isValidHttpUrl('https://a')).toBe(true);
  });

  it('rejects non-http schemes and empties', () => {
    expect(isValidHttpUrl('ftp://x')).toBe(false);
    expect(isValidHttpUrl('octra.network')).toBe(false);
    expect(isValidHttpUrl('')).toBe(false);
    expect(isValidHttpUrl('https://')).toBe(false);
    expect(isValidHttpUrl('http:///path')).toBe(false); // empty host
  });

  it('rejects urls with spaces/tabs', () => {
    expect(isValidHttpUrl('https://a b')).toBe(false);
    expect(isValidHttpUrl('https://a\tb')).toBe(false);
  });
});

describe('network resolution', () => {
  it('lists presets first', () => {
    const nets = allNetworks();
    expect(nets[0]!.id).toBe('devnet');
    expect(nets[1]!.id).toBe('mainnet');
    expect(nets.length).toBe(2);
  });

  it('merges custom networks after presets', () => {
    const nets = allNetworks([
      { id: 'my-net', name: 'My Net', rpcUrl: 'https://x/rpc', explorerUrl: 'https://x' },
    ]);
    expect(nets.length).toBe(3);
    expect(nets[2]!.id).toBe('my-net');
    expect(nets[2]!.custom).toBe(true);
  });

  it('resolves preset + custom defs', () => {
    expect(getNetworkDef('devnet')).toEqual(PRESET_NETWORKS.devnet);
    const custom = [
      { id: 'my-net', name: 'My Net', rpcUrl: 'https://x/rpc', explorerUrl: 'https://x' },
    ];
    expect(getNetworkDef('my-net', custom)?.name).toBe('My Net');
    expect(getNetworkDef('nope', custom)).toBeNull();
  });

  it('flags presets', () => {
    expect(isPresetNetwork('devnet')).toBe(true);
    expect(isPresetNetwork('mainnet')).toBe(true);
    expect(isPresetNetwork('my-net')).toBe(false);
  });

  it('derives unique slug ids that never collide with presets', () => {
    expect(networkIdFromName('My Test Net!', [])).toBe('my-test-net');
    expect(networkIdFromName('devnet', [])).not.toBe('devnet');
    expect(networkIdFromName('dup', ['dup'])).toBe('dup-1');
  });
});

describe('wire-safe network info', () => {
  // A private endpoint of the kind users actually add: a box on their LAN, and a
  // provider URL with the API key in the query string.
  const CUSTOM: CustomNetworkDef[] = [
    {
      id: 'home-node',
      name: 'Home node',
      rpcUrl: 'http://192.168.1.50:8080',
      explorerUrl: 'https://octrascan.io',
      relayerUrl: 'http://192.168.1.50:9000',
      icon: '🏠',
    },
    {
      id: 'paid-rpc',
      name: 'Paid RPC',
      rpcUrl: 'https://rpc.example.com/v1?apikey=sk-secret',
      explorerUrl: 'https://octrascan.io',
    },
  ];

  it('projects a definition down to id, name, explorer, icon and custom flag', () => {
    expect(toNetworkInfo(PRESET_NETWORKS.devnet)).toEqual({
      id: 'devnet',
      name: PRESET_NETWORKS.devnet.name,
      explorerUrl: PRESET_NETWORKS.devnet.explorerUrl,
      icon: PRESET_NETWORKS.devnet.icon,
      custom: false,
    });
  });

  it('omits the icon key entirely when a network has none', () => {
    const info = toNetworkInfo({ id: 'x', name: 'X', rpcUrl: 'https://x/rpc', explorerUrl: '' });
    expect('icon' in info).toBe(false);
  });

  it('never leaks rpcUrl or relayerUrl', () => {
    // The whole point of the projection: a dApp learns which network it is on,
    // not where the user's node lives.
    for (const info of networkInfoList(CUSTOM)) {
      expect(info).not.toHaveProperty('rpcUrl');
      expect(info).not.toHaveProperty('relayerUrl');
    }
    const serialized = JSON.stringify(networkInfoList(CUSTOM));
    expect(serialized).not.toContain('192.168.1.50');
    expect(serialized).not.toContain('sk-secret');
  });

  it('lists user-added networks alongside presets, flagged as custom', () => {
    const list = networkInfoList(CUSTOM);
    expect(list.map((n) => n.id)).toEqual(['devnet', 'mainnet', 'home-node', 'paid-rpc']);
    expect(list.filter((n) => n.custom).map((n) => n.id)).toEqual(['home-node', 'paid-rpc']);
    expect(list.find((n) => n.id === 'home-node')?.name).toBe('Home node');
  });

  it('resolves the active network, custom included', () => {
    expect(activeNetworkInfo('mainnet').custom).toBe(false);
    expect(activeNetworkInfo('home-node', CUSTOM)).toEqual({
      id: 'home-node',
      name: 'Home node',
      explorerUrl: 'https://octrascan.io',
      icon: '🏠',
      custom: true,
    });
  });

  it('still answers for an id whose definition is gone', () => {
    // A custom network deleted while a dApp session was live. The dApp gets a
    // coherent record instead of an error or a null.
    const info = activeNetworkInfo('deleted-net', CUSTOM);
    expect(info).toEqual({ id: 'deleted-net', name: 'deleted-net', explorerUrl: '', custom: true });
  });
});
