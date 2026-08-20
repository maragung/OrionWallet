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
      <div className="qr-fallback" style={{ width: size, height: size }}>
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
      className={className ? `qr-svg ${className}` : 'qr-svg'}
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code"
    >
      <rect width={total} height={total} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
