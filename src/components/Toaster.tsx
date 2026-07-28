import { useUi } from '../stores/uiStore';
import './toaster.css';

export function Toaster() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismiss);
  if (toasts.length === 0) return null;

  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast${t.tone === 'danger' ? ' toast--danger' : ''}`}>
          <span className="grow">{t.message}</span>
          {t.undo && (
            <button
              type="button"
              className="toast__action"
              onClick={() => {
                void t.undo?.();
                dismiss(t.id);
              }}
            >
              Undo
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
