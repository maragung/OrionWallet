import type { IconName } from './Icon';

/**
 * Resolve a network's stored `icon` into one of the wallet's own stroke icons.
 *
 * `NetworkDef.icon` is an emoji, and it stays that way: it is persisted in
 * settings, editable by the user when they add a custom network, and handed to
 * dApps over the connect API, so changing the field's meaning would be a
 * breaking data change for a purely cosmetic reason. Instead the UI treats it as
 * a hint and draws a local icon, so a network looks the same on every OS.
 *
 * Anything unrecognised — including a custom network whose emoji the user picked
 * themselves — falls back to `globe`, which is what the old code already did for
 * networks with no icon at all.
 *
 * Lives here rather than beside one of its callers: the top-bar pill, the settings
 * network list and the connect popup all need the same mapping, and a second copy
 * would be the thing that drifts.
 */
export function networkIcon(net: { id: string; icon?: string }): IconName {
  if (net.id === 'devnet' || net.icon === '🧪') return 'flask';
  if (net.id === 'mainnet' || net.icon === '🚀') return 'rocket';
  return 'globe';
}
