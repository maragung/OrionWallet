import { vi } from 'vitest';

/**
 * Make the PVAC glue script look unbuilt, in every environment alike.
 *
 * `loadPvacModule` probes `<origin>/wasm/pvac.js` with a HEAD request before
 * importing it, so it can tell "never compiled" apart from "blocked by CSP".
 * Nothing serves that path in a unit test — but what the probe *does* is up to
 * the machine: a CI runner has nothing listening on the jsdom origin's port and
 * refuses instantly, while a sandbox where some other service holds that port
 * accepts the connection and never answers, and the request then hangs until the
 * test times out. Stubbing the probe removes the ambient network from the test
 * entirely; the code under test still takes its real "not built" path.
 */
export function stubPvacGlueUnavailable(): void {
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (url.includes('/wasm/pvac.js')) {
      return Promise.reject(new TypeError(`fetch failed: ${url} is not served in tests`));
    }
    return real
      ? real(input, init)
      : Promise.reject(new TypeError(`unexpected fetch in test: ${url}`));
  });
}
