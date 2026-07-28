import { useEffect } from 'react';
import { RouterProvider } from 'react-router/dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Toaster } from './components/Toaster';
import { router } from './router';
import { useLibrary } from './stores/libraryStore';
import { useSettings } from './stores/settingsStore';

export default function App() {
  const loadSettings = useSettings((s) => s.load);
  const loadLibrary = useLibrary((s) => s.load);

  useEffect(() => {
    void loadSettings();
    void loadLibrary();
  }, [loadSettings, loadLibrary]);

  return (
    <ErrorBoundary label="Offbook hit an unexpected error">
      <RouterProvider router={router} />
      <Toaster />
    </ErrorBoundary>
  );
}
