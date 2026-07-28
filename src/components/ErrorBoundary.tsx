import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Shown above the message. Defaults to a generic apology. */
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * A crash inside the reader must not take out the whole app — the user's text is safe in
 * IndexedDB and they need a route back to it.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[offbook] render error', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="page">
        <div className="error-box">
          <h2>{this.props.label ?? 'Something broke on this screen'}</h2>
          <p className="muted" style={{ marginTop: 'var(--sp-2)' }}>
            Your texts are stored on this device and are unaffected.
          </p>
          <pre
            style={{
              marginTop: 'var(--sp-3)',
              whiteSpace: 'pre-wrap',
              fontSize: 'var(--fs-xs)',
              color: 'var(--text-faint)',
            }}
          >
            {error.message}
          </pre>
          <div className="row" style={{ gap: 'var(--sp-2)', marginTop: 'var(--sp-4)' }}>
            <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
            <a className="btn btn--primary" href={import.meta.env.BASE_URL}>
              Back to library
            </a>
          </div>
        </div>
      </div>
    );
  }
}
