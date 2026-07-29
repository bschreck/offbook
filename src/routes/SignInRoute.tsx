import { Link } from 'react-router';
import { AccountPanel } from '../features/account/AccountPanel';
import '../features/account/account.css';
import '../components/sheet.css';

/**
 * A route of its own rather than only a section inside Settings.
 *
 * Sign-in was originally reachable only from Settings, and the empty-state library did not
 * link to Settings at all — so somebody arriving in a fresh browser with an account already
 * had no path to their texts short of guessing a URL. Being a real route also makes it
 * linkable and bookmarkable.
 */
export function SignInRoute() {
  return (
    <main className="page">
      <Link
        to="/"
        className="btn btn--ghost"
        style={{ marginInlineStart: 'calc(var(--sp-3) * -1)' }}
      >
        ‹ Library
      </Link>
      <h1 className="page-title">Your account</h1>
      <AccountPanel />
      <p className="lib__footer">
        <Link to="/settings">Settings</Link> · <Link to="/about">About</Link>
      </p>
    </main>
  );
}
