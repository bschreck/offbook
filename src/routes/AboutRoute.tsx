import { Link } from 'react-router';
import { APP_NAME, APP_TAGLINE } from '../brand';

export function AboutRoute() {
  return (
    <main className="page">
      <Link
        to="/"
        className="btn btn--ghost"
        style={{ marginInlineStart: 'calc(var(--sp-3) * -1)' }}
      >
        ‹ Library
      </Link>
      <h1 className="page-title">{APP_NAME}</h1>
      <p className="muted">{APP_TAGLINE}</p>

      <h2 style={{ marginBlockStart: 'var(--sp-6)', fontSize: 'var(--fs-md)' }}>How to use it</h2>
      <p>
        Read the text aloud. Hide a few words. Read it again, saying the hidden ones from memory.
        When that feels easy, hide more. Your brain only has to hold a little more each time, and
        the difficulty climbs until there is nothing left on the screen and you can still say it.
      </p>
      <p style={{ marginBlockStart: 'var(--sp-3)' }}>
        Press and hold a blank to peek at the word underneath. Peeking is not cheating — it is the
        measurement. If you are peeking constantly, step back down a stage.
      </p>

      {/* ADR-0008 made the old "no network requests at all" sentence false for a signed-in
          user. Saying what is actually true is not optional. */}
      <h2 style={{ marginBlockStart: 'var(--sp-6)', fontSize: 'var(--fs-md)' }}>Privacy</h2>
      <p>
        <strong>With no account, nothing you write leaves this device.</strong> That is the default:
        your texts are stored in your browser and nowhere else. The one request the app makes
        unbidden is on the Settings screen, where it asks our own server whether you are signed in;
        it carries nothing but the question. Put the device in aeroplane mode and everything still
        works.
      </p>
      <p style={{ marginBlockStart: 'var(--sp-3)' }}>
        If you sign in, your texts and your practice history replicate to Offbook’s own server, so
        they reach your other devices. That is the only thing an account does. Nothing goes to a
        third party, there is no analytics and no tracking, and this device stays the original — a
        server outage cannot stop you rehearsing something already here.
      </p>
      <p style={{ marginBlockStart: 'var(--sp-3)' }}>
        Your password is never sent. Your device turns it into a different value and sends only
        that, which is why signing in takes a second — the calculation is deliberately slow so that
        guessing at it is slow too. The flip side: nobody can reset a forgotten password, so keep it
        in your password manager. Signing out leaves the copy on this device alone.
      </p>
      <p style={{ marginBlockStart: 'var(--sp-3)' }}>
        With no account, nothing is backed up for you. Save a backup file from Settings, and install
        Offbook to your home screen — Safari clears an ordinary website’s storage after about a week
        without a visit, and installing is what prevents that.
      </p>
      <p style={{ marginBlockStart: 'var(--sp-3)' }} className="muted">
        Only add material you have the right to use.
      </p>

      <h2 style={{ marginBlockStart: 'var(--sp-6)', fontSize: 'var(--fs-md)' }}>Odds and ends</h2>
      <ul style={{ paddingInlineStart: '1.2em' }}>
        <li>
          Arrow keys, Page Up/Down and Space are bound, so a Bluetooth page-turner pedal or a
          presenter remote works on a music stand with no setup.
        </li>
        <li>
          Press <kbd>?</kbd> shortcuts: <kbd>[</kbd> and <kbd>]</kbd> step the difficulty,{' '}
          <kbd>1</kbd>–<kbd>7</kbd> jump to a stage, <kbd>R</kbd> held reveals everything,{' '}
          <kbd>S</kbd> starts auto-scroll, <kbd>F</kbd> is full screen.
        </li>
        <li>
          Progress is per browser, unless you sign in, in which case it follows your account. Use
          separate browser profiles, or no account, if you need separate progress.
        </li>
        <li>The sample texts are all public domain.</li>
      </ul>

      <h2 style={{ marginBlockStart: 'var(--sp-6)', fontSize: 'var(--fs-md)' }}>Licence</h2>
      <p>
        Offbook is free and open source under the MIT licence. If it ever stops being maintained,
        anyone can host it — that is rather the point.{' '}
        <a href="https://github.com/bschreck/offbook">Source on GitHub</a>.
      </p>
    </main>
  );
}
