import { type ReactNode, useEffect, useRef } from 'react';
import './sheet.css';

interface SheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * A bottom sheet on a native `<dialog>`, for the focus trap and Esc handling we would
 * otherwise hand-roll and get subtly wrong.
 */
export function Sheet({ open, title, onClose, children }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog ref={ref} className="sheet" onClose={onClose} aria-label={title}>
      <div className="sheet__head">
        <h2 className="sheet__title">{title}</h2>
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Done
        </button>
      </div>
      <div className="sheet__body">{children}</div>
    </dialog>
  );
}
