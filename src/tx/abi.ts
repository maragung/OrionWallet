/** Contract ABI helpers. */

/** Try to pull a list of callable method names out of a program-info object. */
export function extractMethods(info: unknown): string[] {
  if (!info || typeof info !== 'object') return [];
  const obj = info as Record<string, unknown>;
  // Common shapes: { abi: { methods: [...] } } | { abi: [...] } | { methods: [...] } | { exports: [...] }
  const candidates: unknown[] = [
    obj.methods,
    obj.exports,
    obj.entrypoints,
    (obj.abi as Record<string, unknown> | undefined)?.methods,
    (obj.abi as Record<string, unknown> | undefined)?.exports,
    (obj.abi as Record<string, unknown> | undefined)?.entrypoints,
    obj.abi,
  ];
  for (const c of candidates) {
    if (!Array.isArray(c)) continue;
    const names = c
      .map((m) => {
        if (typeof m === 'string') return m;
        if (m && typeof m === 'object') {
          const mo = m as Record<string, unknown>;
          const name = mo.name ?? mo.method ?? mo.fn ?? mo.function;
          if (typeof name === 'string') return name;
        }
        return null;
      })
      .filter((n): n is string => !!n);
    if (names.length) return Array.from(new Set(names));
  }
  return [];
}
