import { useEffect } from 'react';
import { RouterProvider } from 'react-router/dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Toaster } from './components/Toaster';
import { UpdatePrompt } from './pwa/UpdatePrompt';
import { router } from './router';
import { useAccount } from './stores/accountStore';
import { useLibrary } from './stores/libraryStore';
import { useSettings } from './stores/settingsStore';

export default function App() {
  const loadSettings = useSettings((s) => s.load);
  const loadLibrary = useLibrary((s) => s.load);
  // Refreshed once at boot rather than per route: the library footer and the empty state both
  // report account status, and without this they said "Sign in to sync" to a signed-in user.
  const refreshAccount = useAccount((s) => s.refresh);

  useEffect(() => {
    void loadSettings();
    void loadLibrary();
    void refreshAccount();
  }, [loadSettings, loadLibrary, refreshAccount]);

  return (
    <ErrorBoundary label="Offbook hit an unexpected error">
      <RouterProvider router={router} />
      <Toaster />
      <UpdatePrompt />
    </ErrorBoundary>
  );
}
