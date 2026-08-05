import { useCallback, useEffect, useRef, useState } from 'react';
import { copyText } from '../utils/clipboard';

/**
 * Copy-to-clipboard button with inline "Copied!" feedback.
 * Feedback is local to the button so it works without a toast.
 */
export function CopyButton({
  value,
  label,
  title = 'Copy',
  className = 'ghost',
  style,
  onCopied,
}: {
  value: string;
  label?: string;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
  onCopied?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const handle = useCallback(async () => {
    try {
      await copyText(value);
      setCopied(true);
      onCopied?.();
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Ignore — the user can still select the text manually.
    }
  }, [value, onCopied]);

  return (
    <button
      type="button"
      className={className}
      onClick={handle}
      title={title}
      aria-label={title}
      style={style}
    >
      {copied ? '✓' : '📋'}
      {label ? ` ${copied ? 'Copied!' : label}` : ''}
    </button>
  );
}
