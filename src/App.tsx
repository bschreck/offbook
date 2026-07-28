import { RouterProvider } from 'react-router/dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { router } from './router';

export default function App() {
  return (
    <ErrorBoundary label="Offbook hit an unexpected error">
      <RouterProvider router={router} />
    </ErrorBoundary>
  );
}
