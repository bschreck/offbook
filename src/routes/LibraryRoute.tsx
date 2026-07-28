import { Link } from 'react-router';

export function LibraryRoute() {
  return (
    <main className="page">
      <h1 className="page-title">Your texts</h1>
      <div className="empty-state">
        <p>Nothing here yet.</p>
        <p style={{ marginTop: 'var(--sp-4)' }}>
          <Link className="btn btn--primary" to="/import">
            Add a text
          </Link>
        </p>
      </div>
    </main>
  );
}
