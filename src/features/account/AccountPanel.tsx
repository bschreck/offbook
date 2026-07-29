import { useEffect, useId, useState } from 'react';
import { normalizeUsername } from '../../shared/auth/kdf';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, USERNAME_RE } from '../../shared/sync/protocol';
import { useAccount } from '../../stores/accountStore';

type Mode = 'signIn' | 'create';

/**
 * Accounts are optional (ADR-0008): everything below is opt-in, and none of it gates the
 * reader. The panel therefore never blocks, and every failure ends as a sentence on screen.
 */
export function AccountPanel() {
  const status = useAccount((s) => s.status);
  const account = useAccount((s) => s.account);
  const busy = useAccount((s) => s.busy);
  const syncing = useAccount((s) => s.syncing);
  const lastSyncAt = useAccount((s) => s.lastSyncAt);
  const lastSyncError = useAccount((s) => s.lastSyncError);
  const refresh = useAccount((s) => s.refresh);
  const signIn = useAccount((s) => s.signIn);
  const signUp = useAccount((s) => s.signUp);
  const signOut = useAccount((s) => s.signOut);
  const syncNow = useAccount((s) => s.syncNow);

  const [mode, setMode] = useState<Mode>('signIn');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const ids = useId();
  const userId = `${ids}-username`;
  const passId = `${ids}-password`;
  const userErrId = `${ids}-username-error`;
  const passErrId = `${ids}-password-error`;
  const passHintId = `${ids}-password-hint`;
  const formErrId = `${ids}-form-error`;

  useEffect(() => {
    // Cheap, and it is the only way to learn whether the session cookie is still good.
    if (status === 'unknown') void refresh();
  }, [status, refresh]);

  const userError = submitted ? usernameProblem(username) : null;
  const passError = submitted ? passwordProblem(password, mode) : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    setServerError(null);
    if (usernameProblem(username) || passwordProblem(password, mode)) return;

    const result =
      mode === 'create' ? await signUp(username, password) : await signIn(username, password);
    if (result.ok) {
      // Nothing derived from the password survives the attempt.
      setPassword('');
      setSubmitted(false);
      const outcome = await syncNow();
      setSyncMessage(outcome.message);
    } else {
      setServerError(result.message);
    }
  };

  if (status === 'signedIn' && account) {
    const fraction = account.quotaBytes > 0 ? account.usageBytes / account.quotaBytes : 0;
    const pct = Math.min(100, Math.round(fraction * 100));
    return (
      <section className="account" aria-labelledby={`${ids}-heading`}>
        <h2 className="account__heading" id={`${ids}-heading`}>
          Your texts sync to your other devices
        </h2>
        <p className="account__who">
          Signed in as <strong>{account.username}</strong>
        </p>

        <p className="account__quota">
          {formatBytes(account.usageBytes)} of {formatBytes(account.quotaBytes)} used on the server
          {pct >= 90 ? ' — nearly full' : ''}
        </p>
        <div className={`account__bar${pct >= 90 ? ' account__bar--full' : ''}`} aria-hidden="true">
          <span style={{ inlineSize: `${Math.max(pct, fraction > 0 ? 2 : 0)}%` }} />
        </div>

        <div className="account__actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={syncing}
            onClick={async () => {
              setSyncMessage(null);
              const outcome = await syncNow();
              setSyncMessage(outcome.message);
            }}
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={async () => {
              const result = await signOut();
              setSyncMessage(null);
              setServerError(result.ok ? null : result.message);
            }}
          >
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>

        <p className="account__note" role="status" aria-live="polite" aria-busy={syncing}>
          {syncing
            ? 'Syncing…'
            : (syncMessage ??
              (lastSyncAt
                ? `Last synced ${formatWhen(lastSyncAt)}.`
                : 'Not synced yet this visit.'))}
        </p>
        {lastSyncError && !syncing && <p className="account__error">{lastSyncError}</p>}
        {serverError && <p className="account__error">{serverError}</p>}
        <p className="account__hint">
          Signing out leaves everything on this device exactly where it is.
        </p>
      </section>
    );
  }

  return (
    <section className="account" aria-labelledby={`${ids}-heading`}>
      <h2 className="account__heading" id={`${ids}-heading`}>
        Sync to your other devices
      </h2>
      <p className="account__blurb">
        Offbook needs no account, and without one nothing you write ever leaves this device. An
        account is only for getting the same library onto your phone, tablet and laptop.
      </p>

      {status === 'unknown' && (
        <p className="account__note">
          Couldn’t reach the server just now, so we can’t tell whether you are signed in. You can
          still sign in below, or carry on — nothing here affects rehearsing.
        </p>
      )}

      <div className="seg" style={{ marginBlockEnd: 'var(--sp-3)' }}>
        <button
          type="button"
          aria-pressed={mode === 'signIn'}
          onClick={() => {
            setMode('signIn');
            setServerError(null);
          }}
        >
          I have an account
        </button>
        <button
          type="button"
          aria-pressed={mode === 'create'}
          onClick={() => {
            setMode('create');
            setServerError(null);
          }}
        >
          Create an account
        </button>
      </div>

      <form className="account__form" onSubmit={submit} aria-busy={busy}>
        <label className="account__label" htmlFor={userId}>
          Username
          <input
            id={userId}
            className="account__input"
            type="text"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
            value={username}
            aria-invalid={userError ? true : undefined}
            aria-describedby={userError ? userErrId : undefined}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        {userError && (
          <p className="account__error" id={userErrId}>
            {userError}
          </p>
        )}

        <label className="account__label" htmlFor={passId}>
          Password
          <input
            id={passId}
            className="account__input"
            type="password"
            name="password"
            autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
            enterKeyHint="go"
            value={password}
            aria-invalid={passError ? true : undefined}
            aria-describedby={
              [passError ? passErrId : null, mode === 'create' ? passHintId : null]
                .filter(Boolean)
                .join(' ') || undefined
            }
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {mode === 'create' && (
          <p className="account__hint" id={passHintId}>
            At least {MIN_PASSWORD_LENGTH} characters. There is no password reset — nobody at
            Offbook can read or restore it, so save it in your password manager.
          </p>
        )}
        {passError && (
          <p className="account__error" id={passErrId}>
            {passError}
          </p>
        )}

        <div className="account__actions">
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? 'Working…' : mode === 'create' ? 'Create account' : 'Sign in'}
          </button>
        </div>

        <p className="account__note" role="status" aria-live="polite" aria-busy={busy}>
          {busy
            ? 'Turning your password into a key, here on this device. It takes about a second, deliberately, and it is why the password itself is never sent.'
            : ''}
        </p>
        {serverError && (
          <p className="account__error" id={formErrId}>
            {serverError}
          </p>
        )}
      </form>
    </section>
  );
}

/**
 * Validated against the normalised form, because that is the value the server stores and the
 * value the KDF salt is derived from (shared/auth/kdf.ts). Typing a capital is not an error.
 */
function usernameProblem(raw: string): string | null {
  const name = normalizeUsername(raw);
  if (name === '') return 'Enter a username.';
  if (name.length < 3) return 'A username needs at least 3 characters.';
  if (name.length > 32) return 'A username can be at most 32 characters.';
  if (!USERNAME_RE.test(name)) {
    return 'Use letters, numbers, dots, dashes or underscores, starting and ending with a letter or number.';
  }
  return null;
}

function passwordProblem(password: string, mode: Mode): string | null {
  if (password === '') return 'Enter your password.';
  if (mode === 'create' && password.length < MIN_PASSWORD_LENGTH) {
    return `A password needs at least ${MIN_PASSWORD_LENGTH} characters — this one has ${password.length}.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `A password can be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatWhen(ts: number): string {
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleString();
}
