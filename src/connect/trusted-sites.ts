/**
 * Trusted-sites management (wallet side).
 *
 * A trusted origin skips ONLY the connect approval prompt. It never skips a
 * signing prompt — every signMessage/signTypedData/approveContract/signContract
 * still requires explicit user confirmation. This bounds the blast radius of a
 * compromised trusted dApp to "can reconnect silently", not "can sign silently".
 */
import {
  addTrustedSite,
  isTrustedSite,
  listTrustedSites,
  removeTrustedSite,
  type TrustedSiteRecord,
} from '../wallet/storage';

/** Validate that a string is a proper web origin (scheme://host[:port]). */
export function isValidOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    // Origin must have no path/query/hash.
    return `${u.protocol}//${u.host}` === origin;
  } catch {
    return false;
  }
}

export async function trustSite(origin: string, label?: string): Promise<void> {
  if (!isValidOrigin(origin)) throw new Error(`Invalid origin: ${origin}`);
  await addTrustedSite({ origin, label, addedAt: Date.now() });
}

export async function untrustSite(origin: string): Promise<void> {
  await removeTrustedSite(origin);
}

export async function siteIsTrusted(origin: string): Promise<boolean> {
  if (!isValidOrigin(origin)) return false;
  return isTrustedSite(origin);
}

export async function getTrustedSites(): Promise<TrustedSiteRecord[]> {
  return listTrustedSites();
}
