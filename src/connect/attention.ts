/**
 * Getting the user's attention when a dApp request needs an answer — once,
 * politely, and reversibly.
 *
 * The popup that hosts an approval prompt is frequently not the window the user
 * is looking at, so something has to signal "your turn". What was here before did
 * that by brute force: a beep on every prompt plus five `window.focus()` calls
 * spread over a second, repeated for each of the three code paths that raise a
 * prompt. That is worse than it sounds:
 *
 *  - Repeated `focus()` does not make a browser more likely to comply. It just
 *    means that if the user tabbed away to copy an address, the popup rips focus
 *    back out from under them up to a second later, mid-keystroke.
 *  - The beep fired even when the popup was already the focused window, so the
 *    user got startled by a noise about a prompt they were already reading.
 *  - Each beep constructed an `AudioContext` and never closed it. Browsers cap
 *    them per page (Chrome allows ~6); after that, every later prompt threw
 *    inside a `try {}` and silently made no sound at all.
 *
 * So: focus once, chime only when the window is actually in the background, close
 * the audio context when the tone ends, and flash the document title for as long
 * as the request is unanswered. The title flash is the part that reliably works —
 * it survives autoplay policy, an ignored `focus()`, and a minimised window,
 * because it shows up in the taskbar and the tab strip.
 */

/** Title shown while a request waits, alternated with the real one. */
const ALERT_TITLE = '🔔 Action needed';

/** How often the title alternates. Slow enough to read, fast enough to notice. */
const FLASH_INTERVAL_MS = 1100;

/** Frequency and length of the background chime. */
const CHIME_HZ = 800;
const CHIME_SECONDS = 0.2;

/**
 * Play a short chime, then release the audio context.
 *
 * Skipped entirely when the document is already visible and focused: the user is
 * looking at the prompt, and a noise adds nothing but a startle.
 */
function chimeIfBackgrounded(): void {
  if (typeof document === 'undefined') return;
  const inForeground = document.visibilityState === 'visible' && document.hasFocus();
  if (inForeground) return;
  const Ctor: typeof AudioContext | undefined =
    typeof AudioContext !== 'undefined'
      ? AudioContext
      : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  let ctx: AudioContext | null = null;
  try {
    ctx = new Ctor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = CHIME_HZ;
    gain.gain.value = 0.15;
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + CHIME_SECONDS);
    osc.start();
    osc.stop(ctx.currentTime + CHIME_SECONDS);
    // Release the context once the tone is done. Without this the popup leaks one
    // per prompt and hits the browser's per-page limit, after which no prompt
    // makes any sound at all.
    const ctxToClose = ctx;
    osc.onended = () => void ctxToClose.close().catch(() => undefined);
  } catch {
    void ctx?.close().catch(() => undefined);
  }
}

/**
 * Signal that a request is waiting for the user.
 *
 * Returns a function that stops signalling and restores the title; call it when
 * the request is answered. Safe to call more than once.
 */
export function requestAttention(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => undefined;
  }

  // Once. A browser either honours this or it does not, and asking five times
  // only adds the chance of stealing focus after the user has moved on.
  try {
    window.focus();
  } catch {
    /* a browser is entitled to refuse; the title flash still lands */
  }

  chimeIfBackgrounded();

  const originalTitle = document.title;
  let showingAlert = false;
  const timer = window.setInterval(() => {
    showingAlert = !showingAlert;
    document.title = showingAlert ? ALERT_TITLE : originalTitle;
  }, FLASH_INTERVAL_MS);

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    window.clearInterval(timer);
    document.title = originalTitle;
  };
}
