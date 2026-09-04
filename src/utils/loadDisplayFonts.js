let profileFontsPromise = null;

/**
 * Nunito is the one warm line on a public profile (the bio). Loading it from
 * main.jsx put a variable font on every first paint, including the feed.
 *
 * Newsreader italic is deliberately not loaded anywhere: no stylesheet in the
 * app sets an italic serif (audit 2026-09-02, A5), and a loader nobody calls
 * is a promise nobody keeps.
 */
export function loadProfileFonts() {
  if (!profileFontsPromise) {
    profileFontsPromise = import('@fontsource-variable/nunito/wght.css');
  }
  return profileFontsPromise;
}
