import { createBrowserRouter } from 'react-router';
import { RouteError } from './components/RouteError';
import { AboutRoute } from './routes/AboutRoute';
import { ImportRoute } from './routes/ImportRoute';
import { LibraryRoute } from './routes/LibraryRoute';
import { NotFoundRoute } from './routes/NotFoundRoute';
import { ReaderRoute } from './routes/ReaderRoute';
import { SettingsRoute } from './routes/SettingsRoute';
import { TextRoute } from './routes/TextRoute';

const errorElement = <RouteError />;

/** Declarative mode: we want routing primitives, not data loaders. PLAN.md §4. */
export const router = createBrowserRouter(
  [
    { path: '/', element: <LibraryRoute />, errorElement },
    { path: '/import', element: <ImportRoute />, errorElement },
    { path: '/t/:id', element: <TextRoute />, errorElement },
    { path: '/t/:id/read', element: <ReaderRoute />, errorElement },
    { path: '/settings', element: <SettingsRoute />, errorElement },
    { path: '/about', element: <AboutRoute />, errorElement },
    { path: '*', element: <NotFoundRoute /> },
  ],
  { basename: import.meta.env.BASE_URL.replace(/\/$/, '') || '/' },
);
