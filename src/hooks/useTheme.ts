/**
 * Theme system — dark/light/system theme with persistence.
 *
 * The theme is stored in IndexedDB settings (via the wallet store) and
 * applied to the document root via `data-theme` attribute. CSS variables
 * in global.css respond to the attribute.
 *
 * Three modes:
 *   - 'dark': always dark
 *   - 'light': always light
 *   - 'system': follows prefers-color-scheme
 */
import { useEffect, useState, useCallback } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { applyThemeColorMeta } from '../styles/theme-colors';
import { writeThemeCookie } from '../utils/theme-cookie';

export type ThemeMode = 'dark' | 'light' | 'system';
export type EffectiveTheme = 'dark' | 'light';

/** Get the system's preferred color scheme. */
function getSystemTheme(): EffectiveTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Resolve a ThemeMode to the effective theme. */
export function resolveTheme(mode: ThemeMode): EffectiveTheme {
  if (mode === 'system') return getSystemTheme();
  return mode;
}

/** Apply the effective theme to <html data-theme="..."> */
function applyTheme(theme: EffectiveTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
  // Update theme-color meta for mobile browser chrome
  applyThemeColorMeta(theme);
  // Mirror into a cookie: the /connect popup and the static pages read this
  // synchronously at boot, before the (async) IndexedDB settings are available.
  writeThemeCookie(theme);
}

/**
 * Theme hook — returns the current theme mode, effective theme, and a setter.
 * Reads from the wallet store's settings.theme field and applies the theme
 * to the document root.
 */
export function useTheme(): {
  mode: ThemeMode;
  effective: EffectiveTheme;
  setMode: (mode: ThemeMode) => Promise<void>;
  toggle: () => Promise<void>;
} {
  const { settings, setSettings, pushToast } = useWalletStore();
  const [effective, setEffective] = useState<EffectiveTheme>(() =>
    resolveTheme((settings?.theme as ThemeMode) ?? 'dark'),
  );

  // Apply theme whenever settings change
  useEffect(() => {
    const mode = (settings?.theme as ThemeMode) ?? 'dark';
    const eff = resolveTheme(mode);
    setEffective(eff);
    applyTheme(eff);
  }, [settings?.theme]);

  // Listen for system theme changes when mode is 'system'
  useEffect(() => {
    if (settings?.theme !== 'system') return;
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () => {
      const eff = getSystemTheme();
      setEffective(eff);
      applyTheme(eff);
    };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [settings?.theme]);

  // Apply theme on mount (initial load before settings are fetched)
  useEffect(() => {
    applyTheme(effective);
  }, [effective]);

  const setMode = useCallback(
    async (mode: ThemeMode) => {
      if (!settings) {
        // Settings not loaded yet — apply theme anyway, will be persisted later
        const eff = resolveTheme(mode);
        applyTheme(eff);
        setEffective(eff);
        return;
      }
      const newSettings = { ...settings, theme: mode };
      await setSettings(newSettings);
      const eff = resolveTheme(mode);
      setEffective(eff);
      applyTheme(eff);
    },
    [settings, setSettings],
  );

  const toggle = useCallback(async () => {
    const nextMode: ThemeMode = effective === 'dark' ? 'light' : 'dark';
    await setMode(nextMode);
    pushToast('info', `Theme: ${nextMode}`);
  }, [effective, setMode, pushToast]);

  return {
    mode: (settings?.theme as ThemeMode) ?? 'dark',
    effective,
    setMode,
    toggle,
  };
}

/** Get the current effective theme without subscribing to changes. */
export function getCurrentTheme(): EffectiveTheme {
  if (typeof document === 'undefined') return 'dark';
  return (document.documentElement.getAttribute('data-theme') as EffectiveTheme) ?? 'dark';
}
