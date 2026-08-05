import { useTheme } from '../hooks/useTheme';

/**
 * Theme toggle button — switches between dark/light theme.
 * Shows a sun icon in dark mode (click to switch to light)
 * and a moon icon in light mode (click to switch to dark).
 */
export function ThemeToggle() {
  const { effective, toggle } = useTheme();

  return (
    <button
      className="theme-toggle"
      onClick={toggle}
      title={`Switch to ${effective === 'dark' ? 'light' : 'dark'} theme`}
      aria-label="Toggle theme"
    >
      {effective === 'dark' ? '☀️' : '🌙'}
    </button>
  );
}
