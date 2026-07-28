import { create } from 'zustand';

export interface Toast {
  id: number;
  message: string;
  /** An inverse action. Present only when the operation is genuinely undoable. */
  undo?: () => void | Promise<void>;
  tone?: 'default' | 'danger';
}

interface UiState {
  toasts: Toast[];
  toast: (message: string, opts?: Omit<Toast, 'id' | 'message'>) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useUi = create<UiState>((set) => ({
  toasts: [],
  toast: (message, opts) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, message, ...opts }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 6000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
