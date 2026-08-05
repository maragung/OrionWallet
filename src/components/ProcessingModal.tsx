import { useEffect, useRef, useState } from 'react';
import { yieldToPaint, sleep, type ProgressReporter, type StepDescriptor } from '../utils/progress';

/**
 * Reusable processing modal — shows multi-stage progress with informative messages.
 *
 * Features:
 *   - Animated spinner dengan stage indicator
 *   - Step list dengan checkmarks untuk completed steps
 *   - Informative messages untuk each stage
 *   - Progress bar (optional, untuk indeterminate atau determinate progress)
 *   - Error display dengan retry button
 *   - Success display dengan action button
 *
 * Usage:
 *   const [stages, setStages] = useState([
 *     { id: 'sign', label: 'Signing transaction', status: 'pending' },
 *     { id: 'submit', label: 'Submitting to network', status: 'pending' },
 *     { id: 'confirm', label: 'Waiting for confirmation', status: 'pending' },
 *   ]);
 *   <ProcessingModal
 *     open={true}
 *     title="Sending Transaction"
 *     stages={stages}
 *     message="Please wait while your transaction is being processed..."
 *   />
 */

export type StageStatus = 'pending' | 'active' | 'done' | 'error';

export interface ProcessingStage {
  id: string;
  label: string;
  description?: string;
  status: StageStatus;
}

interface ProcessingModalProps {
  open: boolean;
  title: string;
  stages?: ProcessingStage[];
  message?: string;
  error?: string | null;
  success?: boolean;
  successMessage?: string;
  successAction?: { label: string; onClick: () => void };
  errorAction?: { label: string; onClick: () => void };
  onClose?: () => void;
  determinate?: boolean;
  progress?: number;
  dismissible?: boolean;
  successActionDisabled?: boolean;
  onCopySuccess?: () => void;
}

export function ProcessingModal({
  open,
  title,
  stages,
  message,
  error,
  success,
  successMessage,
  successAction,
  errorAction,
  onClose,
  determinate = false,
  progress = 0,
  dismissible = false,
  successActionDisabled = false,
  onCopySuccess,
}: ProcessingModalProps) {
  const [elapsed, setElapsed] = useState(0);
  const activeRef = useRef<HTMLDivElement | null>(null);

  // Keep the in-flight step visible when the list is long enough to scroll.
  const activeId = stages?.find((s) => s.status === 'active' || s.status === 'error')?.id;
  useEffect(() => {
    if (!activeId) return;
    activeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeId]);

  // Track elapsed time
  useEffect(() => {
    if (!open) {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 500);
    return () => clearInterval(interval);
  }, [open]);

  // ESC to close (if dismissible)
  useEffect(() => {
    if (!open || !dismissible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onClose) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, dismissible, onClose]);

  if (!open) return null;

  const formatTime = (s: number) => {
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}m ${sec}s`;
  };

  const activeStage = stages?.find((s) => s.status === 'active');
  const completedCount = stages?.filter((s) => s.status === 'done').length ?? 0;
  const totalStages = stages?.length ?? 0;

  return (
    <div
      className="modal-overlay"
      onClick={() => dismissible && onClose?.()}
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
        style={{
          background: 'var(--bg-elevated-1)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--r-lg)',
          padding: 'var(--sp-6)',
          maxWidth: 480,
          width: '100%',
          boxShadow: 'var(--shadow-xl)',
          animation: 'slideUp var(--t-base)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--sp-3)',
            marginBottom: 'var(--sp-4)',
          }}
        >
          {success ? (
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: '50%',
                background: 'var(--success-soft)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 20,
                flexShrink: 0,
              }}
            >
              ✅
            </div>
          ) : error ? (
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: '50%',
                background: 'var(--error-soft)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 20,
                flexShrink: 0,
              }}
            >
              ⚠️
            </div>
          ) : (
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: '50%',
                background: 'var(--accent-soft)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <span className="spinner lg" />
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ fontSize: 'var(--fs-md)', fontWeight: 'var(--fw-semibold)', margin: 0 }}>
              {success ? 'Success' : error ? 'Error' : title}
            </h3>
            {!success && !error && elapsed > 0 && (
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
                Elapsed: {formatTime(elapsed)}
                {totalStages > 0 && ` • Step ${completedCount + 1}/${totalStages}`}
              </div>
            )}
          </div>
          {dismissible && onClose && (
            <button
              className="ghost icon"
              onClick={onClose}
              style={{ minHeight: 32, minWidth: 32, fontSize: 16 }}
              aria-label="Close"
            >
              ✕
            </button>
          )}
        </div>

        {/* Success message */}
        {success && successMessage && (
          <div
            style={{
              padding: 'var(--sp-4)',
              background: 'var(--success-soft)',
              borderRadius: 'var(--r-md)',
              fontSize: 'var(--fs-sm)',
              color: 'var(--text-primary)',
              marginBottom: successAction ? 'var(--sp-4)' : 0,
              whiteSpace: 'pre-wrap',
            }}
          >
            {successMessage}
          </div>
        )}

        {/* Copy hash button */}
        {success && onCopySuccess && (
          <div style={{ marginBottom: successAction ? 'var(--sp-4)' : 0 }}>
            <button
              className="ghost"
              style={{ minHeight: 32, fontSize: 'var(--fs-xs)' }}
              onClick={onCopySuccess}
            >
              📋 Copy Details
            </button>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div
            style={{
              padding: 'var(--sp-4)',
              background: 'var(--error-soft)',
              border: '1px solid var(--error)',
              borderRadius: 'var(--r-md)',
              fontSize: 'var(--fs-sm)',
              color: 'var(--error)',
              marginBottom: 'var(--sp-4)',
              wordBreak: 'break-word',
            }}
          >
            {error}
          </div>
        )}

        {/* Stages */}
        {stages && stages.length > 0 && !success && (
          <div
            style={{
              marginBottom: 'var(--sp-4)',
              maxHeight: '42vh',
              overflowY: 'auto',
              paddingRight: 'var(--sp-1)',
            }}
          >
            {stages.map((stage, i) => (
              <div
                key={stage.id}
                ref={stage.status === 'active' || stage.status === 'error' ? activeRef : undefined}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 'var(--sp-3)',
                  padding: 'var(--sp-2) 0',
                  opacity: stage.status === 'pending' ? 0.5 : 1,
                }}
              >
                <div
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    marginTop: 2,
                    background:
                      stage.status === 'done'
                        ? 'var(--success-soft)'
                        : stage.status === 'active'
                          ? 'var(--accent-soft)'
                          : stage.status === 'error'
                            ? 'var(--error-soft)'
                            : 'var(--bg-elevated-3)',
                    color:
                      stage.status === 'done'
                        ? 'var(--success)'
                        : stage.status === 'active'
                          ? 'var(--accent)'
                          : stage.status === 'error'
                            ? 'var(--error)'
                            : 'var(--text-muted)',
                    fontSize: 12,
                    fontWeight: 'var(--fw-semibold)',
                  }}
                >
                  {stage.status === 'done' ? '✓' : stage.status === 'error' ? '✗' : i + 1}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 'var(--fs-sm)',
                      fontWeight:
                        stage.status === 'active' ? 'var(--fw-semibold)' : 'var(--fw-normal)',
                      color:
                        stage.status === 'pending' ? 'var(--text-muted)' : 'var(--text-primary)',
                    }}
                  >
                    {stage.label}
                    {stage.status === 'active' && (
                      <span
                        className="spinner"
                        style={{
                          width: 10,
                          height: 10,
                          marginLeft: 'var(--sp-2)',
                          verticalAlign: 'middle',
                        }}
                      />
                    )}
                  </div>
                  {stage.description && (
                    <div
                      style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 }}
                    >
                      {stage.description}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Progress bar (determinate) */}
        {determinate && !success && !error && (
          <div style={{ marginBottom: 'var(--sp-4)' }}>
            <div
              style={{
                height: 6,
                background: 'var(--bg-elevated-3)',
                borderRadius: 'var(--r-full)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${Math.min(100, Math.max(0, progress))}%`,
                  background: 'var(--accent)',
                  borderRadius: 'var(--r-full)',
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
            <div
              style={{
                fontSize: 'var(--fs-xs)',
                color: 'var(--text-muted)',
                marginTop: 'var(--sp-1)',
                textAlign: 'right',
              }}
            >
              {Math.round(progress)}%
            </div>
          </div>
        )}

        {/* Message */}
        {message && !success && !error && (
          <div
            style={{
              padding: 'var(--sp-3)',
              background: 'var(--bg-elevated-2)',
              borderRadius: 'var(--r-md)',
              fontSize: 'var(--fs-sm)',
              color: 'var(--text-secondary)',
              marginBottom: 'var(--sp-4)',
            }}
          >
            {activeStage?.description || message}
          </div>
        )}

        {/* Actions */}
        {(successAction || errorAction) && (
          <div style={{ display: 'flex', gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
            {errorAction && (
              <button className="primary" onClick={errorAction.onClick}>
                {errorAction.label}
              </button>
            )}
            {successAction && (
              <button
                className="primary"
                onClick={successAction.onClick}
                disabled={successActionDisabled}
              >
                {successAction.label}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Hook for managing processing modal state.
 *
 * Besides the imperative helpers it exposes a `reporter`: a `ProgressReporter`
 * that the API layer can drive directly, so the step list in the modal stays in
 * sync with the actual crypto/network work without the panel having to
 * orchestrate every stage by hand.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useProcessingModal(options?: { minStepMs?: number }) {
  const minStepMs = options?.minStepMs ?? 140;
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('Processing');
  const [stages, setStages] = useState<ProcessingStage[]>([]);
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | undefined>();

  /** When the currently-active step became active, for the minimum-duration floor. */
  const stepStartedAt = useRef<number>(0);

  const start = (title: string, steps: StepDescriptor[] | ProcessingStage[], message?: string) => {
    setTitle(title);
    setStages(
      steps.map((s) => ({
        id: s.id,
        label: s.label,
        description: s.description,
        status: ('status' in s ? s.status : 'pending') as StageStatus,
      })),
    );
    setMessage(message);
    setError(null);
    setSuccess(false);
    setSuccessMessage(undefined);
    setOpen(true);
  };

  const updateStage = (id: string, status: StageStatus, description?: string) => {
    setStages((prev) =>
      prev.map((s) =>
        s.id === id ? { ...s, status, description: description ?? s.description } : s,
      ),
    );
  };

  const setError_ = (msg: string) => {
    setError(msg);
  };

  const setSuccess_ = (msg: string) => {
    setSuccess(true);
    setSuccessMessage(msg);
  };

  const close = () => {
    setOpen(false);
    setError(null);
    setSuccess(false);
  };

  /**
   * Progress reporter bound to this modal.
   *
   * `begin` paints the active state before the caller starts its (often
   * main-thread-blocking) work; `done` holds the completed step on screen for
   * at least `minStepMs` so fast steps remain readable.
   */
  const reporter = useRef<ProgressReporter>({
    async begin(id, description) {
      updateStage(id, 'active', description);
      await yieldToPaint();
      stepStartedAt.current = Date.now();
    },
    async done(id, description) {
      const elapsed = Date.now() - stepStartedAt.current;
      if (elapsed < minStepMs) await sleep(minStepMs - elapsed);
      updateStage(id, 'done', description);
      await yieldToPaint();
    },
    fail(id, description) {
      updateStage(id, 'error', description);
    },
  }).current;

  return {
    open,
    title,
    stages,
    message,
    error,
    success,
    successMessage,
    start,
    updateStage,
    reporter,
    setError: setError_,
    setSuccess: setSuccess_,
    close,
    modalProps: { open, title, stages, message, error, success, successMessage, onClose: close },
  };
}
