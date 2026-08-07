import { describe, it, expect } from 'vitest';
import {
  isValidHttpUrl,
  allNetworks,
  getNetworkDef,
  isPresetNetwork,
  networkIdFromName,
  PRESET_NETWORKS,
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
