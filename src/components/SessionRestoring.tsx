/**
 * Shown while an unlock session is being reopened after a page reload.
 *
 * Matches the unlock screen's shell so restoring a session looks like the app
 * coming back rather than a different screen flashing past on the way to it.
 */
export function SessionRestoring() {
  return (
    <div
      style={{
        minHeight: '100vh',
        ...({ minHeight: '100dvh' } as React.CSSProperties),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--sp-4)',
        background: 'radial-gradient(ellipse at top, var(--bg-elevated-1) 0%, var(--bg-base) 60%)',
      }}
    >
      <div
        className="card"
        style={{
          width: '100%',
          maxWidth: 420,
          padding: 'var(--sp-8) var(--sp-6)',
          textAlign: 'center',
          boxShadow: 'var(--shadow-xl)',
        }}
      >
        <img
          src="/logo.png"
          alt="Octra"
          style={{ width: 56, height: 56, marginBottom: 'var(--sp-3)' }}
        />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 'var(--sp-2)',
            color: 'var(--text-muted)',
            fontSize: 'var(--fs-sm)',
          }}
        >
          <span className="spinner" />
          <span>Restoring your session…</span>
        </div>
      </div>
    </div>
  );
}
