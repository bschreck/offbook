/**
 * The ONLY place the product name appears. See PLAN.md §1 (rebrand insurance):
 * persisted identifiers — the IndexedDB database name, the backup format string — are
 * deliberately name-independent, so renaming the product is never a data migration.
 */
export const APP_NAME = 'Offbook';
export const APP_TAGLINE = 'Learn it by heart, one hidden word at a time.';
export const APP_URL = 'https://offbook-4ev.pages.dev/';

/** Never rename these two. They are written into users' devices and backup files. */
export const DB_NAME = 'lines';
export const BACKUP_FORMAT = 'lines.backup';
