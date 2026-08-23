import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { yieldToPaint, sleep, type ProgressReporter, type StepDescriptor } from '../utils/progress';
import { Icon } from './icons/Icon';

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

  const dialog = (
    <div className="modal-overlay" onClick={() => dismissible && onClose?.()}>
      <div
        className="modal-content lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {/* Header */}
        <div className="modal-head">
          {success ? (
            <span className="modal-icon ok">
              <Icon name="check-circle" size={20} />
            </span>
          ) : error ? (
            <span className="modal-icon danger">
              <Icon name="alert-triangle" size={20} />
            </span>
          ) : (
            <span className="modal-icon accent">
              <span className="spinner lg" />
            </span>
          )}
          <div className="modal-title-group">
            <h3 className="modal-title">{success ? 'Success' : error ? 'Error' : title}</h3>
            {!success && !error && elapsed > 0 && (
              <div className="modal-sub">
                Elapsed: {formatTime(elapsed)}
                {totalStages > 0 && ` • Step ${completedCount + 1}/${totalStages}`}
              </div>
            )}
          </div>
          {dismissible && onClose && (
            <button className="icon-btn plain" onClick={onClose} aria-label="Close">
              <Icon name="x" size={18} />
            </button>
          )}
        </div>

        {/* Success message */}
        {success && successMessage && (
          <div className="info-box ok spaced">
            <Icon name="check-circle" size={18} />
            <span className="pre-wrap">{successMessage}</span>
          </div>
        )}

        {/* Copy hash button */}
        {success && onCopySuccess && (
          <div className="row tight modal-inline-action">
            <button className="ghost btn-sm" onClick={onCopySuccess}>
              <Icon name="copy" size={14} /> Copy Details
            </button>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div className="info-box err spaced" role="alert">
            <Icon name="alert-triangle" size={18} />
            <span>{error}</span>
          </div>
        )}

        {/* Stages */}
        {stages && stages.length > 0 && !success && (
          <div className="step-list">
            {stages.map((stage, i) => (
              <div
                key={stage.id}
                className={`step ${stage.status}`}
                ref={stage.status === 'active' || stage.status === 'error' ? activeRef : undefined}
              >
                <span className="step-mark">
                  {stage.status === 'done' ? (
                    <Icon name="check" size={14} strokeWidth={2.5} />
                  ) : stage.status === 'error' ? (
                    <Icon name="x" size={14} strokeWidth={2.5} />
                  ) : (
                    i + 1
                  )}
                </span>
                <div className="step-body">
                  <div className="step-label">
                    {stage.label}
                    {stage.status === 'active' && <span className="spinner" />}
                  </div>
                  {stage.description && <div className="step-desc">{stage.description}</div>}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Progress bar (determinate) */}
        {determinate && !success && !error && (
          <div className="modal-progress">
            <div className="progress">
              {/* The width is the datum, so it stays inline. */}
              <div
                className="progress-fill"
                style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
              />
            </div>
            <div className="progress-pct">{Math.round(progress)}%</div>
          </div>
        )}

        {/* Message */}
        {message && !success && !error && (
          <div className="info-box spaced">
            <Icon name="info" size={18} />
            <span>{activeStage?.description || message}</span>
          </div>
        )}

        {/* Actions */}
        {(successAction || errorAction) && (
          <div className="modal-actions">
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

  /* Render through a portal: when mounted inside `.app-header` (AccountPicker),
     that header's backdrop-filter makes it the containing block for
     `position: fixed`, and its stacking context paints this modal behind the
     page. document.body is a clean top-level layer. */
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
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
