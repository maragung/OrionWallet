import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './icons/Icon';

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
    <div className="modal-overlay" onClick={close}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title ?? 'Scan QR code'}
      >
        <div className="modal-head">
          <span className="modal-icon accent">
            <Icon name="camera" size={20} />
          </span>
          <h3 className="modal-title">{title ?? 'Scan QR code'}</h3>
          <button className="icon-btn plain" onClick={close} aria-label="Close scanner">
            <Icon name="x" size={18} />
          </button>
        </div>

        {error ? (
          <div className="info-box warn" role="alert">
            <Icon name="alert-triangle" size={18} />
            <span>{error}</span>
          </div>
        ) : (
          <>
            <div className="scan-stage">
              <video ref={videoRef} muted playsInline />
              {/* Framing guide — purely visual, no layout impact on the video. */}
              <div className="scan-reticle" aria-hidden="true" />
              {starting && (
                <div className="scan-status">
                  <span className="spinner" />
                  Starting camera…
                </div>
              )}
            </div>
            <p className="scan-hint">
              {hint ??
                'Point the camera at a QR code. Frames are decoded on-device; nothing is uploaded.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
