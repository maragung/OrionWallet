/**
 * PanelSkeleton — placeholder shown while a panel's prerequisites (wallet,
 * settings, RPC client) are still resolving.
 *
 * Panels used to `return null` in that window, which left the main content area
 * completely empty and made the app look like it had gone blank right after
 * unlock. Rendering a titled skeleton card keeps the layout's shape and tells
 * the user something is in flight, while the global LoadingOverlay handles the
 * modal spinner on top.
 */
export function PanelSkeleton({
  title,
  message = 'Preparing wallet…',
  rows = 2,
}: {
  title: string;
  message?: string;
  rows?: number;
}) {
  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">{title}</div>
      </div>
      <div className="stack">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className={`skeleton ${i === 0 ? 'title' : 'row'}`} />
        ))}
        <div className="field-note">{message}</div>
      </div>
    </div>
  );
}
