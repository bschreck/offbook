import { Sheet } from '../../components/Sheet';
import { METHOD_LIST } from '../../core/mask/registry';
import type { MethodId } from '../../core/mask/types';
import type { Document } from '../../core/text/types';
import { useReader } from '../../stores/readerStore';

export function MethodSheet({
  open,
  onClose,
  doc,
  currentMethod,
}: {
  open: boolean;
  onClose: () => void;
  doc: Document;
  currentMethod: MethodId;
}) {
  const setMethod = useReader((s) => s.setMethod);
  const hasRoles = doc.roles.length > 0;

  return (
    <Sheet open={open} title="How to hide" onClose={onClose}>
      <div className="choice-list">
        {METHOD_LIST.map((m) => {
          // A method that needs speakers is useless on a text with none — say so rather
          // than letting the user pick it and see nothing happen.
          const unavailable = m.needsRoles === true && !hasRoles;
          return (
            <button
              key={m.id}
              type="button"
              className="choice"
              aria-pressed={m.id === currentMethod}
              disabled={unavailable}
              onClick={() => {
                setMethod(m.id);
                onClose();
              }}
            >
              <span className="choice__name">{m.name}</span>
              <span className="choice__blurb">
                {unavailable ? 'Needs a script with character names.' : m.blurb}
              </span>
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}
