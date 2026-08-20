import { useTheme } from '../hooks/useTheme';
import { Icon } from './icons';

/**
 * Theme toggle button — flips dark ⇄ light in one click.
 *
 * Shows the theme it will switch *to*, not the one currently active: a sun while
 * dark, a moon while light. The alternative (showing the current state) is a
 * button whose icon never changes meaning but never tells you what pressing it
 * does either.
 *
 * `aria-label` is fixed at "Toggle theme" rather than describing the destination,
 * so assistive tech and the e2e suite address one stable control. The changing
 * destination lives in `title`.
 */
export function ThemeToggle({ className }: { className?: string } = {}) {
  const { effective, toggle } = useTheme();

  return (
    <button
      className={`theme-toggle ${className ?? ''}`.trim()}
      onClick={toggle}
      title={`Switch to ${effective === 'dark' ? 'light' : 'dark'} theme`}
      aria-label="Toggle theme"
    >
      <Icon name={effective === 'dark' ? 'sun' : 'moon'} size={18} />
    </button>
  );
}
