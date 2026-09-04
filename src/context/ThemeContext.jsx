/* eslint-disable react-refresh/only-export-components */
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { ThemeContext } from './contexts';
import {
  applyTheme,
  persistTheme,
  readStoredTheme,
  systemPrefersDark,
} from '../utils/theme';
import { runThemeSwitch } from '../utils/themeTransition';

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
 * Pressing the toggle ends that — a choice is a choice — and the only way back
 * to following the system is clearing the site's storage. A three-way control
 * (light / auto / dark) is the follow-up that would fix it, and it belongs in
 * Settings, not in the bar.
 */
export function ThemeProvider({ children }) {
  const [chosen, setChosen] = useState(readStoredTheme);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event) => setSystemDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const theme = chosen || (systemDark ? 'dark' : 'light');

  // The inline script in index.html has already painted the right side before
  // React ran; this keeps the attribute honest for every change after that,
  // including a system flip while the tab is open.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback((origin) => {
    const next = theme === 'dark' ? 'light' : 'dark';
    runThemeSwitch(() => {
      // Inside the view transition the change has to be synchronous, so the
      // attribute is written here rather than waited for from the effect above
      // — which then repeats it harmlessly on the next render.
      applyTheme(next);
      persistTheme(next);
      setChosen(next);
    }, origin);
  }, [theme]);

  const value = useMemo(() => ({
    theme,
    isDark: theme === 'dark',
    followsSystem: chosen === null,
    toggleTheme,
  }), [theme, chosen, toggleTheme]);

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
