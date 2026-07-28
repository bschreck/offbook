import { Link, useRouteError } from 'react-router';

/** Rendered by the router when a route throws. The library is always one tap away. */
export function RouteError() {
  const error = useRouteError();
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';

  return (
    <main className="page">
      <div className="error-box">
        <h2>This screen didn’t load</h2>
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
          {message}
        </pre>
        <p style={{ marginTop: 'var(--sp-4)' }}>
          <Link className="btn btn--primary" to="/">
            Back to library
          </Link>
        </p>
      </div>
    </main>
  );
}
