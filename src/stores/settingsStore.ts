import { create } from 'zustand';
import { loadSettings, saveSetting } from '../data/repos/settings';
import { DEFAULT_SETTINGS, type SettingsShape } from '../data/schema';

interface SettingsState {
  settings: SettingsShape;
  loaded: boolean;
  load: () => Promise<void>;
  set: <K extends keyof SettingsShape>(key: K, value: SettingsShape[K]) => Promise<void>;
}

/**
 * Settings are kept in their own store so that a reader font-size drag does not notify
 * library subscribers. PLAN.md §4 — the three-store split is a performance decision.
 */
export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  load: async () => {
    const settings = await loadSettings();
    set({ settings, loaded: true });
    applyTheme(settings['ui.theme']);
  },

  set: async (key, value) => {
    // Optimistic: the UI must not wait on IndexedDB to move a slider.
    set({ settings: { ...get().settings, [key]: value } });
    if (key === 'ui.theme') applyTheme(value as SettingsShape['ui.theme']);
    await saveSetting(key, value);
  },
}));

export function applyTheme(theme: SettingsShape['ui.theme']): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}
