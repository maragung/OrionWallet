import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Icon } from './icons/Icon';

/**
 * ErrorBoundary — keeps a render-time crash from blanking the whole app.
 *
 * Without a boundary, React 18 unmounts the entire tree when a component
 * throws during render. That leaves `#root` empty, which triggers the
 * `#root:empty::before { content: 'Loading Orion Wallet…' }` fallback in
 * index.html — the "white page stuck on loading" symptom. Catching the error
 * here keeps the rest of the shell (header, sidebar, nav) alive and shows a
 * recoverable error card instead.
 *
 * Wrap each panel with a `key` (e.g. the active tab) so switching tabs resets
 * a boundary that has already tripped.
 */
interface Props {
  children: ReactNode;
  /** Shown as the card title. Defaults to a generic message. */
  title?: string;
  /** Called when the user clicks Retry, after internal state is reset. */
  onReset?: () => void;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <Icon name="alert-triangle" size={18} /> {this.props.title ?? 'Something went wrong'}
          </div>
        </div>
        <div className="empty-state danger compact">
          <div className="icon">
            <Icon name="alert-octagon" size={28} />
          </div>
          <div className="title">This panel failed to render</div>
          <div className="desc break-word">{error.message || String(error)}</div>
          <div className="empty-actions">
            <button className="primary" onClick={this.handleRetry}>
              <Icon name="refresh" size={16} /> Retry
            </button>
            <button className="ghost" onClick={() => window.location.reload()}>
              Reload app
            </button>
          </div>
        </div>
      </div>
    );
  }
}
