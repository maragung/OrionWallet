/**
 * Network definitions for the wallet: built-in presets + user-added custom
 * networks. Each network carries an RPC URL, an explorer URL, and an optional
 * circle **relayer** URL (used by the oct:// browser's compute bridge).
 *
 * `isValidHttpUrl` is ported verbatim from webcli (main.cpp:267-276) so URL
 * validation matches the official client exactly.
 */

/** A network identifier. Presets use 'devnet'/'mainnet'; custom use their id. */
export type NetworkId = 'devnet' | 'mainnet' | (string & {});

export interface NetworkDef {
  id: NetworkId;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
  /** Circle relayer endpoint (oct:// compute). Optional. */
  relayerUrl?: string;
  /** Display icon (emoji). */
  icon?: string;
  /** True for user-added networks (deletable). */
  custom?: boolean;
}

/** Built-in networks, keyed by id. */
export const PRESET_NETWORKS: Record<'devnet' | 'mainnet', NetworkDef> = {
  devnet: {
    id: 'devnet',
    name: 'Devnet',
    rpcUrl: 'https://devnet.octrascan.io/rpc',
    explorerUrl: 'https://devnet.octrascan.io',
    icon: '🧪',
  },
  mainnet: {
    id: 'mainnet',
    name: 'Mainnet',
    rpcUrl: 'https://octra.network/rpc',
    explorerUrl: 'https://octrascan.io',
    icon: '🚀',
  },
};

export const PRESET_IDS: NetworkId[] = ['devnet', 'mainnet'];

/** True when a network id is a built-in preset (never deletable). */
export function isPresetNetwork(id: NetworkId): boolean {
  return id === 'devnet' || id === 'mainnet';
}

/**
 * Validate an http(s) URL exactly like webcli `is_valid_http_url`
 * (main.cpp:267-276): must be http/https, have a non-empty host, and contain
 * no spaces or tabs.
 */
export function isValidHttpUrl(url: string): boolean {
  const https = url.startsWith('https://');
  const http = url.startsWith('http://');
  if (!https && !http) return false;
  const rest = url.slice(https ? 8 : 7);
  if (!rest) return false;
  if (rest.includes(' ') || rest.includes('\t')) return false;
  const slash = rest.indexOf('/');
  const host = slash === -1 ? rest : rest.slice(0, slash);
  return host.length > 0;
}

/**
 * Shape stored on the Settings record for a user-added network.
 * (Kept structurally identical to NetworkDef minus the derived `custom` flag.)
 */
export interface CustomNetworkDef {
  id: string;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
  relayerUrl?: string;
  icon?: string;
}

/** All networks: presets first, then custom (as full NetworkDefs). */
export function allNetworks(customNetworks?: CustomNetworkDef[]): NetworkDef[] {
  const custom = (customNetworks ?? []).map((c) => ({ ...c, custom: true }) as NetworkDef);
  return [PRESET_NETWORKS.devnet, PRESET_NETWORKS.mainnet, ...custom];
}

/** Resolve a network id to its definition (preset or custom); null if unknown. */
export function getNetworkDef(
  id: NetworkId,
  customNetworks?: CustomNetworkDef[],
): NetworkDef | null {
  if (id === 'devnet') return PRESET_NETWORKS.devnet;
  if (id === 'mainnet') return PRESET_NETWORKS.mainnet;
  const found = (customNetworks ?? []).find((c) => c.id === id);
  return found ? { ...found, custom: true } : null;
}

/**
 * The view of a network that leaves the wallet — sent to the connect popup's
 * caller and to dApps over the SDK channel.
 *
 * Deliberately **not** the whole `NetworkDef`: `rpcUrl` and `relayerUrl` are
 * omitted. A user-added network is frequently a private endpoint
 * (`http://192.168.1.50:8080`, a tunnel, a paid provider key in the query
 * string), and handing that to every site the user connects to would leak their
 * infrastructure. dApps never need it either — every read goes through the
 * wallet (`wallet_getBalance` and friends) and execution never leaves the
 * wallet UI. What a dApp legitimately needs is which network it is talking to,
 * whether the wallet's owner added it by hand, and where to link a transaction.
 */
export interface NetworkInfo {
  id: NetworkId;
  name: string;
  explorerUrl: string;
  icon?: string;
  /** True when the wallet's owner added this network manually. */
  custom: boolean;
}

/** Project a full definition down to the fields that may cross the wire. */
export function toNetworkInfo(def: NetworkDef): NetworkInfo {
  return {
    id: def.id,
    name: def.name,
    explorerUrl: def.explorerUrl,
    ...(def.icon ? { icon: def.icon } : {}),
    custom: def.custom === true,
  };
}

/** Every network the wallet offers, presets first, as wire-safe info. */
export function networkInfoList(customNetworks?: CustomNetworkDef[]): NetworkInfo[] {
  return allNetworks(customNetworks).map(toNetworkInfo);
}

/**
 * Wire-safe info for the active network. Never null: an id with no definition
 * (a custom network deleted while a session was live) still resolves to a
 * usable entry, so a dApp gets a coherent answer instead of an error.
 */
export function activeNetworkInfo(id: NetworkId, customNetworks?: CustomNetworkDef[]): NetworkInfo {
  const def = getNetworkDef(id, customNetworks);
  if (def) return toNetworkInfo(def);
  return { id, name: id, explorerUrl: '', custom: true };
}

/** Slugify a display name into a stable custom network id. */
export function networkIdFromName(name: string, existing: NetworkId[]): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'network';
  let id = base;
  let n = 1;
  const taken = new Set(existing);
  while (taken.has(id) || id === 'devnet' || id === 'mainnet') {
    id = `${base}-${n++}`;
  }
  return id;
}
