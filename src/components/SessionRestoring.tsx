/**
 * Shown while an unlock session is being reopened after a page reload.
 *
 * Matches the unlock screen's shell so restoring a session looks like the app
 * coming back rather than a different screen flashing past on the way to it. It
 * reuses `.auth-shell` / `.auth-card` for exactly that reason: the two screens
 * cannot drift apart if they are the same classes.
 */
export function SessionRestoring() {
  return (
    <div className="auth-shell">
      <div className="card auth-card auth-card-center">
        <div className="auth-head">
          <img src="/logo.png" alt="Octra" className="auth-logo" />
        </div>
        <div className="auth-restoring">
          <span className="spinner" />
          <span>Restoring your session…</span>
        </div>
      </div>
    </div>
  );
}
