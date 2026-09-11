import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/**
 * Marking a paper read used to fade the card out and pull it from the feed
 * a second and a half later. The paper stays; the eye becomes the tick.
 */
test('SOURCE: marking a paper read keeps it in the feed', async () => {
  const context = stripComments(await read('../../context/FeedContext.jsx'));
  const body = context.slice(context.indexOf('const markAsRead = useCallback('), context.indexOf('const trackViewTime = useCallback('));
  assert.doesNotMatch(body, /setPapers\(/, 'the card is not removed from the feed when it is marked read');
  const card = stripComments(await read('./PaperCard.jsx'));
  assert.doesNotMatch(card, /isMarkingRead|pc--fade-out/, 'no fade-out, no delayed unmount');
  assert.match(card, /if \(isRead\) \{\s*onUnmarkAsRead\(paper\.id\);[\s\S]*?return;\s*\}\s*onMarkAsRead\(paper\);/,
    'the mark lands at once; a second press takes it back instead of landing again');
});

/**
 * The read button is a toggle. Pressing it on a read paper takes the mark
 * back: the tick folds away first, the eye springs back a beat later, and the
 * slot dips as its teal fill drains. Every surface that mounts a card hands
 * it the way back, not only the way in.
 */
test('SOURCE: every card mount can take a read mark back', async () => {
  const card = stripComments(await read('./PaperCard.jsx'));
  assert.match(card, /onUnmarkAsRead = \(\) => \{\},/, 'the prop has a safe default');
  assert.match(card, /setReleasingRead\(true\);[\s\S]*?setTimeout\(\(\) => setReleasingRead\(false\), READ_RELEASE_MS\)/,
    'the release class is transient');
  assert.match(card, /useEffect\(\(\) => \(\) => clearTimeout\(releaseTimerRef\.current\), \[\]\)/,
    'and its timer is cleared on unmount');
  assert.match(card, /releasingRead && !isReadActive \? 'pc-side-btn--unreading' : ''/);
  assert.match(card, /onUnmarkAsRead=\{onUnmarkAsRead\}/, 'the related-paper card gets it too');
  const mounts = [
    ['../Feed/FeedContainer.jsx', /onUnmarkAsRead=\{unmarkAsRead\}/],
    ['../Search/SearchPage.jsx', /onUnmarkAsRead=\{unmarkAsRead\}/],
    ['../Explorer/EntityExplorer.jsx', /onUnmarkAsRead=\{unmarkAsRead\}/],
    ['../Report/ScientificReport.jsx', /onUnmarkAsRead=\{unmarkAsRead\}/],
    ['../Public/PublicPaperPage.jsx', /onUnmarkAsRead=\{unmarkAsRead\}/],
    ['../Lists/ListsPage.jsx', /onUnmarkAsRead=\{forgetRead\}/],
  ];
  for (const [path, pattern] of mounts) {
    assert.match(await read(path), pattern, `${path} hands the card the way back`);
  }
  const lists = stripComments(await read('../Lists/ListsPage.jsx'));
  assert.match(lists, /const forgetRead = \(paperId\) => \{\s*unmarkAsRead\(paperId\);[\s\S]*?'__read__'/,
    'on the lists page the row also leaves the reading list');
});

test('SOURCE: the way back is the same gesture played the other way', async () => {
  const css = stripComments(await read('./PaperCard.css'));
  // The rule that opens with this selector alone — not the one where it is
  // the last of a comma-separated list.
  const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(`(?<=^|[^,]\\n)${escaped} \\{[^}]*`));
    assert.ok(match, `expected a rule for ${selector}`);
    return match[0];
  };
  assert.match(rule('.pc-side-icon--morph .pc-icon-eye'), /transition-delay: 0\.06s/, 'at rest the eye is the arriving glyph');
  const checkRest = rule('.pc-side-icon--morph .pc-icon-check');
  assert.match(checkRest, /transition-duration: 0\.18s, 0\.22s/, 'the tick folds fast');
  assert.match(checkRest, /transition-delay: 0s/, 'and first');
  const checkRead = rule('.pc-side-btn--read .pc-side-icon--morph .pc-icon-check');
  assert.match(checkRead, /cubic-bezier\(0\.34, 1\.56, 0\.64, 1\)/, 'in the read state the tick is the one that springs');
  assert.match(rule('.pc-side-btn--read .pc-side-icon--morph .pc-icon-eye'), /transition-delay: 0s/, 'and the eye leaves at once');
  assert.match(css, /@keyframes readRelease \{[\s\S]*?45% \{ transform: scale\(0\.9\); \}/, 'the slot dips');
  assert.match(css, /\.pc-side-btn--unreading \.pc-side-icon \{\s*animation: readRelease/);
  assert.match(css, /prefers-reduced-motion: reduce\)[\s\S]*?\.pc-side-btn--unreading \.pc-side-icon \{\s*animation: none;/);
});

test('SOURCE: the eye and the tick share the slot so one can turn into the other', async () => {
  const card = await read('./PaperCard.jsx');
  assert.match(card, /<Eye size=\{20\} className="pc-icon-eye" aria-hidden="true" \/>\s*<CheckCircle2 size=\{20\} className="pc-icon-check" aria-hidden="true" \/>/);
  assert.match(card, /pressed=\{isReadActive\}/, 'the read button is a ui Toggle whose pressed state is isReadActive');
  const css = await read('./PaperCard.css');
  assert.match(css, /\.pc-side-btn--read \.pc-side-icon--morph \.pc-icon-eye \{[\s\S]*?opacity: 0;[\s\S]*?transform: scale\(0\.5\) rotate\(20deg\);/);
  assert.match(css, /\.pc-side-btn--read \.pc-side-icon--morph \.pc-icon-check \{[\s\S]*?opacity: 1;[\s\S]*?transform: none;/);
  assert.match(css, /cubic-bezier\(0\.34, 1\.56, 0\.64, 1\)/, 'the tick overshoots and settles');
  assert.doesNotMatch(css, /\.pc--fade-out/);
});

test('SOURCE: a stored copy from a list or a profile row opens on the skeleton', async () => {
  const lists = await read('../Lists/ListsPage.jsx');
  assert.match(lists, /navigate\(path, \{ state: \{ paper, stored: true \} \}\)/);
  const profile = await read('../Public/PublicProfilePage.jsx');
  assert.match(profile, /state=\{row\.seed \? \{ paper: row\.seed, stored: true \} : undefined\}/);
  const palette = await read('../../utils/searchDestinations.js');
  assert.match(palette, /state: \{ paper \}/, 'the palette hands over the paper itself, which does paint');
});

/**
 * The rail holds still. It is centred on its own height — `translate: 0 -50%`
 * against the card on a phone, `align-self: center` beside it otherwise — so
 * any change to that height moves every button in the column, like and
 * comments and save included.
 *
 * Exactly one label here changes at runtime: this button's. It crosses between
 * one line ("Leído", "Leer", "Abrir fuente") and two ("Leer artículo",
 * "Versión abierta") when the reader marks the paper read, and again when the
 * open-access copy resolves a moment after the paper is opened — that second
 * one arrives unannounced, which is how it was noticed. Measured on 390x844
 * against the built stylesheet: 12.5 px of rail before this, 0 after, with the
 * like button's top identical across all eight label states.
 */
test('the read button reserves both its lines, so the rail never moves under it', async () => {
  const css = await readFile(new URL('./PaperCard.css', import.meta.url), 'utf8');
  const rule = css.match(/\.pc-side-btn--seen \.pc-side-label \{[^}]*\}/)?.[0];
  assert.ok(rule, 'the seen button reserves its label box');
  // 0.625rem/1.25 — two lines is 2.5em of the label's own size.
  assert.match(rule, /min-height: 2\.5em;/);
  // `min-`, so a third line would still fit rather than spill.
  assert.doesNotMatch(rule, /\n\s*height:/, 'a fixed height would clip a longer translation');
});

test('SOURCE: la etiqueta del ojo es «Mark as read»/«Read», nunca la acción de abrir', async () => {
  const card = stripComments(await read('./PaperCard.jsx'));
  const slot = card.slice(card.indexOf('pc-side-btn--seen'), card.indexOf('pc-side-btn--skip'));
  assert.doesNotMatch(slot, /Read article|Open version|Open source|Leer artículo|Versión abierta/);
  assert.match(slot, /isReadActive\s*\?\s*\(isEnglish \? 'Read' : 'Leído'\)\s*:\s*\(isEnglish \? 'Mark as read' : 'Marcar leído'\)/);
});
