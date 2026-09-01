let profileFontsPromise = null;
let italicSerifPromise = null;

/**
 * Nunito is the one warm line on a public profile (the bio). Loading it from
 * main.jsx put a variable font on every first paint, including the feed.
 */
export function loadProfileFonts() {
  if (!profileFontsPromise) {
    profileFontsPromise = import('@fontsource-variable/nunito/wght.css');
  }
  return profileFontsPromise;
}

/**
 * Newsreader italic is only needed when a page actually paints italic serif
 * copy. The roman variable face stays on the boot path for paper titles.
 */
export function loadItalicSerifFont() {
  if (!italicSerifPromise) {
    italicSerifPromise = import('@fontsource-variable/newsreader/opsz-italic.css');
  }
  return italicSerifPromise;
}
