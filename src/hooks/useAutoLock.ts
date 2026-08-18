/**
 * Idle auto-lock.
 *
 * Two jobs, both driven by real user interaction:
 *   1. Keep the persisted unlock session's idle clock honest, so "30 minutes of
 *      inactivity" is measured from the last thing the user actually did — not
 *      from the last page load.
 *   2. Lock the wallet once that window elapses, even if the tab was never
 *      reloaded. Without this, the idle rule would only ever apply on refresh:
 *      a tab left open all night would stay unlocked while a reload after 31
 *      idle minutes asked for the PIN.
 *
 * The window comes from Settings (`autoLockMinutes`, default 30). Setting it to
 * 0 disables the idle lock; the absolute 8 h cap in wallet/unlock-session.ts
 * still applies to a restored session.
 */
import { useEffect, useRef } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { idleMsFromSettings, touchUnlockSession } from '../wallet/unlock-session';

/** How often the idle window is re-checked. */
const CHECK_INTERVAL_MS = 15_000;
/** Don't rewrite the session envelope more than this often while typing. */
const TOUCH_THROTTLE_MS = 15_000;

/** Interactions that count as "the user is still here". */
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export function useAutoLock(): void {
  const isUnlocked = useWalletStore((s) => s.isUnlocked);
  const settings = useWalletStore((s) => s.settings);
  const lock = useWalletStore((s) => s.lock);
  const pushToast = useWalletStore((s) => s.pushToast);

  const idleMs = idleMsFromSettings(settings);
  const lastActivityRef = useRef(Date.now());
  const lastTouchRef = useRef(0);

  useEffect(() => {
    if (!isUnlocked || idleMs <= 0) return;

    // A fresh unlock (or a policy change) restarts the window.
    lastActivityRef.current = Date.now();

    const onActivity = () => {
      const now = Date.now();
      lastActivityRef.current = now;
      if (now - lastTouchRef.current >= TOUCH_THROTTLE_MS) {
        lastTouchRef.current = now;
        touchUnlockSession(now);
      }
    };

    const check = () => {
      if (Date.now() - lastActivityRef.current < idleMs) return;
      const minutes = Math.round(idleMs / 60_000);
      pushToast('warning', `Wallet locked after ${minutes} minutes of inactivity`);
      lock();
    };

    for (const evt of ACTIVITY_EVENTS) {
      window.addEventListener(evt, onActivity, { passive: true });
    }
    // Coming back to a backgrounded tab is the moment a device that slept
    // through the whole window shows up — check then, don't wait for the timer.
    document.addEventListener('visibilitychange', check);
    const timer = window.setInterval(check, CHECK_INTERVAL_MS);

    return () => {
      for (const evt of ACTIVITY_EVENTS) window.removeEventListener(evt, onActivity);
      document.removeEventListener('visibilitychange', check);
      window.clearInterval(timer);
    };
  }, [isUnlocked, idleMs, lock, pushToast]);
}
