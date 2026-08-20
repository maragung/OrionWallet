import { useCallback, useEffect, useRef, useState } from 'react';
import { copyText } from '../utils/clipboard';
import { Icon } from './icons/Icon';

/**
 * Copy-to-clipboard button with inline "Copied!" feedback.
 * Feedback is local to the button so it works without a toast.
 */
export function CopyButton({
  value,
  label,
  title = 'Copy',
  className = 'ghost',
  onCopied,
}: {
  value: string;
  label?: string;
  title?: string;
  className?: string;
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
      /* Only when the button is icon-only: with a visible label, an aria-label
         would replace the words the user can actually see with a shorter,
         different name. */
      aria-label={label ? undefined : title}
    >
      <Icon name={copied ? 'check' : 'copy'} size={16} className={copied ? 'icon-ok' : undefined} />
      {label ? <span>{copied ? 'Copied!' : label}</span> : null}
    </button>
  );
}
