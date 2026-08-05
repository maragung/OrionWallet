export function LoadingOverlay({ loading, message }: { loading: boolean; message?: string }) {
  if (!loading) return null;
  return (
    <div className="loading-overlay">
      <div className="content">
        <span className="spinner" />
        <span>{message || 'Loading...'}</span>
      </div>
    </div>
  );
}
