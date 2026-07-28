import { Link } from 'react-router';

export function NotFoundRoute() {
  return (
    <main className="page">
      <h1 className="page-title">Not found</h1>
      <p className="muted">That page doesn’t exist.</p>
      <p style={{ marginTop: 'var(--sp-4)' }}>
        <Link className="btn btn--primary" to="/">
          Back to library
        </Link>
      </p>
    </main>
  );
}
