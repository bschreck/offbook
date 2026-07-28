import { registerSW } from 'virtual:pwa-register';
import { useEffect, useState } from 'react';
import './updatePrompt.css';

/**
 * `skipWaiting: false` is deliberate: we must never swap the JS bundle under someone
 * mid-scene. The corollary is that there has to be a way to say yes — without this prompt
 * an installed copy would serve the old bundle until every tab was closed, which is
 * indistinguishable from the app being broken.
 */
export function UpdatePrompt() {
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [update, setUpdate] = useState<(() => Promise<void>) | null>(null);

  useEffect(() => {
    const updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        setNeedsRefresh(true);
        setUpdate(() => () => updateSW(true));
      },
    });
  }, []);

  if (!needsRefresh) return null;

  return (
    <div className="update-prompt" role="status">
      <span className="grow">A new version of Offbook is ready.</span>
      <button type="button" className="update-prompt__action" onClick={() => void update?.()}>
        Reload
      </button>
      <button
        type="button"
        className="update-prompt__dismiss"
        onClick={() => setNeedsRefresh(false)}
        aria-label="Not now"
      >
        ×
      </button>
    </div>
  );
}
