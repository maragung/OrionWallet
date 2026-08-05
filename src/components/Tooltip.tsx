import { useState, type ReactNode } from 'react';

/**
 * Reusable tooltip — shows help text on hover/focus.
 *
 * Usage:
 *   <Tooltip text="The recipient's Octra address (starts with 'oct')">
 *     <span className="help-icon">?</span>
 *   </Tooltip>
 *
 *   <Tooltip text="Enter 8-64 chars. If under 15, must include letter + digit + symbol">
 *     <label>PIN <Tooltip text="...">ⓘ</Tooltip></label>
 *   </Tooltip>
 */

interface TooltipProps {
  text: string;
  children: ReactNode;
  /** Position of the tooltip relative to trigger */
  position?: 'top' | 'bottom' | 'left' | 'right';
  /** Max width of the tooltip content */
  maxWidth?: number;
}

export function Tooltip({ text, children, position = 'top', maxWidth = 280 }: TooltipProps) {
  const [visible, setVisible] = useState(false);

  const positionStyles: Record<string, React.CSSProperties> = {
    top: {
      bottom: '100%',
      left: '50%',
      transform: 'translateX(-50%)',
      marginBottom: 'var(--sp-2)',
    },
    bottom: { top: '100%', left: '50%', transform: 'translateX(-50%)', marginTop: 'var(--sp-2)' },
    left: { right: '100%', top: '50%', transform: 'translateY(-50%)', marginRight: 'var(--sp-2)' },
    right: { left: '100%', top: '50%', transform: 'translateY(-50%)', marginLeft: 'var(--sp-2)' },
  };

  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', cursor: 'help' }}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
      tabIndex={0}
    >
      {children}
      {visible && (
        <span
          role="tooltip"
          style={{
            position: 'absolute',
            ...positionStyles[position],
            background: 'var(--bg-elevated-3)',
            color: 'var(--text-primary)',
            padding: 'var(--sp-2) var(--sp-3)',
            borderRadius: 'var(--r-md)',
            fontSize: 'var(--fs-xs)',
            lineHeight: 1.4,
            whiteSpace: 'normal',
            maxWidth,
            width: 'max-content',
            boxShadow: 'var(--shadow-lg)',
            border: '1px solid var(--border-default)',
            zIndex: 10000,
            pointerEvents: 'none',
            animation: 'fadeIn var(--t-fast)',
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}

/**
 * Inline help badge — shows a small "?" icon with tooltip.
 */
export function HelpBadge({ text }: { text: string }) {
  return (
    <Tooltip text={text}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: 'var(--bg-elevated-3)',
          color: 'var(--text-muted)',
          fontSize: 10,
          fontWeight: 'var(--fw-semibold)',
          marginLeft: 'var(--sp-1)',
          verticalAlign: 'middle',
        }}
      >
        ?
      </span>
    </Tooltip>
  );
}
