/**
 * Step-progress reporting shared by long-running wallet operations
 * (encrypt / decrypt / stealth send) and the UI that visualises them.
 *
 * The API layer stays UI-agnostic: it receives a `ProgressReporter` and
 * announces what it is about to do (`begin`) and what the result was
 * (`done` / `fail`). The UI layer supplies a reporter that maps those calls
 * onto `ProcessingModal` stages.
 *
 * Both `begin` and `done` are async on purpose. Most of the heavy work here is
 * synchronous WASM (FHE encryption, zero-knowledge and range proofs) which
 * blocks the main thread, so React can never repaint mid-operation. Awaiting
 * the reporter gives the renderer a chance to paint the "active" state *before*
 * the blocking call starts, and enforces a small minimum visible duration so
 * fast steps do not flash past unreadably.
 */

/** Declarative description of one step, used to seed the UI step list. */
export interface StepDescriptor {
  id: string;
  label: string;
  /** Shown while the step is pending/active, until `done` supplies a detail. */
  description?: string;
}

export interface ProgressReporter {
  /** Mark `id` as active and yield to the renderer so the change is painted. */
  begin(id: string, description?: string): Promise<void>;
  /** Mark `id` as complete, optionally replacing its description with a result. */
  done(id: string, description?: string): Promise<void>;
  /** Mark `id` as failed. */
  fail(id: string, description?: string): void;
}

/** Reporter that does nothing — lets callers omit progress entirely. */
export const noopProgress: ProgressReporter = {
  async begin() {},
  async done() {},
  fail() {},
};

/**
 * Yield to the browser so pending React commits are painted.
 *
 * Two rAF ticks straddle a paint: the first callback runs before the frame is
 * composited, the second after. Falls back to a macrotask under jsdom/node
 * where `requestAnimationFrame` may be missing.
 */
export function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      setTimeout(resolve, 0);
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Truncate long crypto material for display; never used on secret values. */
export function shorten(s: string, head = 10, tail = 6): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** Human-readable size of a base64 payload's decoded bytes. */
export function b64Size(s: string): string {
  const clean = s.includes('|') ? s.slice(s.indexOf('|') + 1) : s;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const bytes = Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
  return formatBytes(bytes);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
