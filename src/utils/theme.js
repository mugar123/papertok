/**
 * The reader's side of the paper: light or dark, and how that choice is stored.
 *
 * Three values live in `papertok_theme`: `light`, `dark`, or nothing at all,
 * which means "whatever the system says" and is the default. There is no
 * `auto` string on purpose — an absent key already means auto, and storing the
 * word as well would have given the same state two spellings.
 *
 * The resolved theme is written to `<html data-theme>`, and `variables.css`
 * hangs the whole dark palette off that one attribute. The same three lines
 * run inline in `app.html` before the first paint: a theme decided in React
 * is a theme decided after the page has already been painted white, which is a
 * white flash on every load for anyone reading in the dark. Two further pages
 * that never import this module carry their own independent copy for the same
 * reason: `index.html` (the landing) and `privacy.html` (the privacy policy).
 * `app.html` and `privacy.html` also repaint the `theme-color` meta; the
 * landing only sets the attribute. Four copies in all — this module plus
 * those three inline scripts, which `grep -rl papertok_theme` lists. Keep them
 * in step: this module is the one that must be right, but the inline copies
 * are the ones seen first.
 */

export const THEME_STORAGE_KEY = 'papertok_theme';

/** What the system asks for when the reader has expressed no preference. */
export function systemPrefersDark() {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/** `light` | `dark` | null (follow the system). */
export function readStoredTheme() {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    return null;
  }
}

export function persistTheme(theme) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The choice still holds for this session if storage is unavailable.
  }
}

/**
 * Paints the choice. The `theme-color` meta rides along so the browser chrome
 * on a phone — the address bar, the notch strip in standalone mode — is the
 * colour of the page under it rather than the white it was born with.
 */
export function applyTheme(theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#111318' : '#ffffff');
}
