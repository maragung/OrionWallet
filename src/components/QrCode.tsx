import { useMemo, useState } from 'react';
import { encodeQr } from '../crypto/qr';

/**
 * Render a payload as a scannable QR code using inline SVG.
 * SVG keeps it crisp at any size and needs no canvas/DOM measuring.
 */
export function QrCode({
  value,
  size = 200,
  className,
}: {
  value: string;
  size?: number;
  className?: string;
}) {
  const [error, setError] = useState<string | null>(null);

  const qr = useMemo(() => {
    try {
      setError(null);
      return encodeQr(value);
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, [value]);

  if (error || !qr) {
    return (
      <div
        style={{
          width: size,
          height: size,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg-elevated-2)',
          borderRadius: 'var(--r-md)',
          color: 'var(--text-muted)',
          fontSize: 'var(--fs-xs)',
          textAlign: 'center',
          padding: 'var(--sp-3)',
        }}
      >
        QR unavailable
      </div>
    );
  }

  const quiet = 4; // spec-mandated quiet zone (modules)
  const total = qr.size + quiet * 2;

  // Build one path for all dark modules — far fewer DOM nodes than per-rect.
  let path = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y * qr.size + x]) {
        path += `M${x + quiet},${y + quiet}h1v1h-1z`;
      }
    }
  }

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code"
      style={{ borderRadius: 'var(--r-md)', display: 'block' }}
    >
      <rect width={total} height={total} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
