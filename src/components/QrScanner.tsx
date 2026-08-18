import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Camera QR scanner.
 *
 * Uses the platform `BarcodeDetector` rather than bundling a decoder: it is
 * hardware-accelerated where available and adds nothing to the bundle. When it
 * is missing (Safari, Firefox) the modal says so plainly instead of showing a
 * dead camera preview — the user can still paste the address by hand.
 *
 * The stream is stopped on close and on unmount; a camera left running is both
 * a privacy problem and a battery one.
 */

// ── Minimal local typings ────────────────────────────────────────────────────
// `BarcodeDetector` is not in TypeScript's DOM library yet. Only the parts we
// actually call are declared; everything else is deliberately absent so a typo
// fails the build rather than silently returning undefined.
interface DetectedBarcode {
  rawValue: string;
  format: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?(): Promise<string[]>;
}

function getDetectorCtor(): BarcodeDetectorCtor | null {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof ctor === 'function' ? ctor : null;
}

/** How often to run detection. 250 ms is responsive without pinning the CPU. */
const DETECT_INTERVAL_MS = 250;

export interface QrScannerProps {
  open: boolean;
  /** Card title. Defaults to a generic scan prompt. */
  title?: string;
  /** Hint shown under the preview. */
  hint?: string;
  /** Called with the decoded text. The scanner closes itself first. */
  onResult: (text: string) => void;
  onClose: () => void;
}

export function QrScanner({ open, title, hint, onResult, onClose }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  // Guards against a second result firing while the modal is closing.
  const doneRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) for (const track of stream.getTracks()) track.stop();
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.srcObject = null;
    }
  }, []);

  const close = useCallback(() => {
    stop();
    onClose();
  }, [onClose, stop]);

  // Start the camera when opened; tear it down on close/unmount.
  useEffect(() => {
    if (!open) return;
    doneRef.current = false;
    setError(null);

    // Camera access needs a secure context, and so does the detector.
    if (!window.isSecureContext) {
      setError(
        'Camera access needs a secure context (https, or localhost). Paste the address instead.',
      );
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser exposes no camera API. Paste the address instead.');
      return;
    }
    const Detector = getDetectorCtor();
    if (!Detector) {
      setError(
        'This browser has no built-in QR decoder (BarcodeDetector). Chrome, Edge, and Android browsers do — otherwise paste the address instead.',
      );
      return;
    }

    let cancelled = false;
    const detector = new Detector({ formats: ['qr_code'] });
    setStarting(true);

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(async (stream) => {
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        video.srcObject = stream;
        try {
          await video.play();
        } catch {
          // Autoplay can be refused even with a live stream; the preview then
          // stays black but detection still works off the first frames.
        }
        if (cancelled) return;
        setStarting(false);

        timerRef.current = window.setInterval(() => {
          const el = videoRef.current;
          if (!el || doneRef.current || el.readyState < 2) return;
          detector
            .detect(el)
            .then((codes) => {
              const raw = codes[0]?.rawValue?.trim();
              if (!raw || doneRef.current) return;
              doneRef.current = true;
              stop();
              onResult(raw);
            })
            .catch(() => {
              // A single failed frame is normal (mid-resize, no data yet).
              // Keep polling; a permanent failure surfaces as "no result".
            });
        }, DETECT_INTERVAL_MS);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setStarting(false);
        const name = e instanceof DOMException ? e.name : '';
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          setError(
            'Camera permission was denied. Allow it in your browser’s site settings, or paste the address instead.',
          );
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          setError('No camera found on this device. Paste the address instead.');
        } else if (name === 'NotReadableError') {
          setError('The camera is already in use by another app. Close it and try again.');
        } else {
          setError(e instanceof Error ? e.message : 'Could not start the camera.');
        }
      });

    return () => {
      cancelled = true;
      stop();
    };
  }, [open, onResult, stop]);

  // ESC closes, matching ConfirmDialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      onClick={close}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.6)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 3000,
        padding: 'var(--sp-4)',
        animation: 'fadeIn var(--t-base)',
      }}
    >
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title ?? 'Scan QR code'}
        style={{
          background: 'var(--bg-elevated-1)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--r-lg)',
          padding: 'var(--sp-6)',
          maxWidth: 440,
          width: '100%',
          boxShadow: 'var(--shadow-xl)',
          animation: 'slideUp var(--t-base)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--sp-3)',
            marginBottom: 'var(--sp-4)',
          }}
        >
          <h3 style={{ fontSize: 'var(--fs-md)', fontWeight: 'var(--fw-semibold)', margin: 0 }}>
            📷 {title ?? 'Scan QR code'}
          </h3>
          <button className="ghost icon" onClick={close} aria-label="Close scanner">
            ✕
          </button>
        </div>

        {error ? (
          <div
            style={{
              padding: 'var(--sp-3)',
              background: 'var(--warning-soft)',
              border: '1px solid var(--warning)',
              borderRadius: 'var(--r-md)',
              fontSize: 'var(--fs-sm)',
              color: 'var(--text-secondary)',
              lineHeight: 1.5,
            }}
          >
            ⚠️ {error}
          </div>
        ) : (
          <>
            <div
              style={{
                position: 'relative',
                borderRadius: 'var(--r-md)',
                overflow: 'hidden',
                background: '#000',
                aspectRatio: '1 / 1',
              }}
            >
              <video
                ref={videoRef}
                muted
                playsInline
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
              {/* Framing guide — purely visual, no layout impact on the video. */}
              <div
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  inset: '15%',
                  border: '2px solid rgba(255, 255, 255, 0.85)',
                  borderRadius: 'var(--r-md)',
                  boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.25)',
                  pointerEvents: 'none',
                }}
              />
              {starting && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#fff',
                    fontSize: 'var(--fs-sm)',
                    gap: 'var(--sp-2)',
                  }}
                >
                  <span className="spinner" style={{ width: 12, height: 12 }} />
                  Starting camera…
                </div>
              )}
            </div>
            <p
              style={{
                fontSize: 'var(--fs-xs)',
                color: 'var(--text-secondary)',
                marginTop: 'var(--sp-3)',
                marginBottom: 0,
                lineHeight: 1.5,
              }}
            >
              {hint ??
                'Point the camera at a QR code. Frames are decoded on-device; nothing is uploaded.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
