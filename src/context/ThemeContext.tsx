import type { PropsWithChildren } from 'react';
export interface ThemeContextValue {
  theme: 'light' | 'dark';
  isDark: boolean;
  followsSystem: boolean;
  preference: 'light' | 'dark' | 'system';
  toggleTheme: (origin?: HTMLElement | null) => void;
  setPreference: (value: 'light' | 'dark' | 'system') => void;
}

/* eslint-disable react-refresh/only-export-components */
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { ThemeContext } from './contexts.ts';
import {
  applyTheme,
  clearStoredTheme,
  persistTheme,
  readStoredTheme,
  systemPrefersDark,
} from '../utils/theme.ts';
import { runThemeSwitch } from '../utils/themeTransition.ts';

/**
 * Light or dark, and nothing else — no palette, no per-surface overrides. The
 * whole theme is one attribute on `<html>` and the block of tokens hanging off
 * it in `variables.css`.
 *
 * The preference is per device, not per account: it lives in localStorage and
 * never reaches Firestore. Someone reading on a phone at night and on a desktop
 * at noon wants two different answers, and syncing the choice would give them
 * one. That is also why this provider sits above `AuthProvider`'s work rather
 * than inside it — the theme is settled before there is a session to ask.
 *
 * Until the reader chooses, the system decides and keeps deciding: with nothing
 * stored, a machine that switches to dark at sunset switches the app with it.
 * Pressing the toggle ends that — a choice is a choice. The way back is the
 * three-way control in the account menu (light / dark / system):
 * `setPreference('system')` forgets the stored choice, and the system decides
 * again, live.
 */
export function ThemeProvider({ children }: PropsWithChildren) {
  const [chosen, setChosen] = useState(readStoredTheme);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const theme = chosen || (systemDark ? 'dark' : 'light');

  // The inline script in app.html has already painted the right side before
  // React ran; this keeps the attribute honest for every change after that,
  // including a system flip while the tab is open.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    runThemeSwitch(() => {
      // Inside the view transition the change has to be synchronous, so the
      // attribute is written here rather than waited for from the effect above
      // — which then repeats it harmlessly on the next render.
      applyTheme(next);
      persistTheme(next);
      setChosen(next);
    });
  }, [theme]);

  /** 'light' | 'dark' | 'system': the three-way choice. */
  const setPreference = useCallback((next: 'light' | 'dark' | 'system') => {
    const target = next === 'system' ? (systemDark ? 'dark' : 'light') : next;
    runThemeSwitch(() => {
      applyTheme(target);
      if (next === 'system') clearStoredTheme();
      else persistTheme(next);
      setChosen(next === 'system' ? null : next);
    });
  }, [systemDark]);

  const value = useMemo<ThemeContextValue>(() => ({
    theme,
    isDark: theme === 'dark',
    followsSystem: chosen === null,
    preference: chosen ?? 'system',
    toggleTheme,
    setPreference,
  }), [theme, chosen, toggleTheme, setPreference]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
