import { useState, type ReactNode } from 'react';
import { Icon } from './icons/Icon';

/**
 * Reusable tooltip — shows help text on hover/focus.
 *
 * Usage:
 *   <Tooltip text="The recipient's Octra address (starts with 'oct')">
 *     <span className="info-hint">…</span>
 *   </Tooltip>
 *
 * For the common case — a small info glyph next to a field label — use `InfoHint`
 * below rather than assembling the wrapper by hand.
 */

interface TooltipProps {
  text: string;
  children: ReactNode;
  /** Position of the tooltip relative to trigger */
  position?: 'top' | 'bottom' | 'left' | 'right';
}

export function Tooltip({ text, children, position = 'top' }: TooltipProps) {
  const [visible, setVisible] = useState(false);

  return (
    <span
      className="tooltip-wrap"
      /* The wrapper is what receives focus, so it is what a screen reader
         announces — without a name it would be an unlabelled stop that reads as
         nothing at all. */
      aria-label={text}
      tabIndex={0}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {children}
      {visible && (
        <span role="tooltip" className={`tooltip-pop ${position}`}>
          {text}
        </span>
      )}
    </span>
  );
}

/**
 * The info glyph that sits beside a field label and explains the field.
 *
 * It exists as a component because the same three-element assembly was repeated
 * beside almost every input in the app, and because the glyph inside must stay
 * unfocusable and hidden from assistive tech: `Tooltip` is already the focus stop
 * and already carries the text as its accessible name.
 */
export function InfoHint({
  text,
  position,
}: {
  text: string;
  position?: TooltipProps['position'];
}) {
  return (
    <Tooltip text={text} position={position}>
      <span className="info-hint" aria-hidden="true">
        <Icon name="info" size={14} />
      </span>
    </Tooltip>
  );
}

/**
 * Inline help badge — the same hint drawn as a small `?`.
 */
export function HelpBadge({ text }: { text: string }) {
  return (
    <Tooltip text={text}>
      <span className="help-badge" aria-hidden="true">
        ?
      </span>
    </Tooltip>
  );
}
