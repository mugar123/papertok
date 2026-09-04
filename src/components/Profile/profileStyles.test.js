import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * A `var(--token)` that no stylesheet defines resolves to nothing, and the
 * declaration is dropped in silence — no console warning, no build error, and
 * the page merely looks slightly wrong. F1 shipped four of these (`--space-7`,
 * `--fs-md`, `--danger`, `--success`) and they were only caught by looking at
 * the deployed page.
 *
 * Growing beyond the stylesheets F1 owned needed the allowlist below, for the
 * locally-scoped properties components inject through
 * `style={{ '--stagger-index': n }}`. Those are not design tokens and must not
 * be defined in variables.css — but they are also not the bug, so the check has
 * to be able to tell the two apart instead of skipping whole files.
 */

/**
 * Custom properties a component sets on an element itself. Each needs the
 * inline `style={{ ... }}` that supplies it named here, so an entry cannot
 * quietly become cover for a genuinely missing token.
 */
const INJECTED_PROPERTIES = new Map([
  ['--stagger-index', '../Lists/ListsPage.jsx'],
  ['--loading-row-index', '../Search/SearchPage.jsx'],
  ['--search-item-index', '../Search/SearchPage.jsx'],
  ['--settings-index', '../Settings/SettingsPage.jsx'],
  // Which entry of the index rail the marker sits on, set on the list itself
  // so the marker's travel is a multiplication rather than a measurement.
  ['--settings-active', '../Settings/SettingsPage.jsx'],
  ['--profile-toc-active', '../Profile/ProfilePage.jsx'],
  ['--follow-rows', '../Public/FollowSheet.jsx'],
  // The comments sheet takes the research field of the paper it hangs off, the
  // same way a card or an entity header does, so its rules and monogram are
  // tinted by the data rather than by a decorative default.
  ['--area-accent', '../Comments/CommentsSheet.jsx'],
  // A list's colour is the owner's choice, so it cannot be a token: the lists
  // page resolves it per list and sets it on the card. It is deliberately not
  // `--area-accent` — inside an open list both appear at once, the header
  // wearing the list's colour and each row its paper's field.
  ['--list-accent', '../Lists/ListsPage.jsx'],
]);

const OWNED = [
  '../Profile/ProfilePage.css',
  '../Public/PublicProfilePage.css',
  '../Public/FollowSheet.css',
  '../Comments/CommentsSheet.css',
  '../Settings/MyCommentsPage.css',
  '../Admin/ModerationPage.css',
  // Added with the save-and-organize fix, which introduced `.save-modal-retry`.
  // The file was already clean, so this costs nothing and stops the next token
  // added here from being the one nobody notices.
  '../Lists/SaveToListModal.css',
  // Added once its `--bg-hover` was dealt with: the token was defined nowhere,
  // so `.lists-retry-btn:hover` had no background at all — a live instance of
  // exactly this bug, found by the sweep rather than by looking at the page.
  // It now uses `--bg-glass-hover`, like every other hover in the app.
  '../Lists/ListsPage.css',
  // Added when the public list page gained the share button and the navbar
  // offsets: the file was already clean, and the tokens the new rules reach for
  // (`--nav-height`, `--accent-success`, `--accent-danger`) are exactly the kind
  // that get typed from memory and silently dropped.
  '../Lists/PublicListPage.css',
  // Joined once its dead `--text-muted` (used seven times, defined nowhere,
  // every declaration silently dropped) was replaced with the existing
  // `--text-tertiary` in the redesign pass. Its two locally-injected
  // properties are declared above.
  '../Search/SearchPage.css',
  // Both were already clean when checked during the redesign pass; adding them
  // costs nothing and covers the settings surface too.
  '../Settings/SettingsPage.css',
  '../Settings/FollowingSettingsPage.css',
  // The heading shared by every /settings/* sub-page.
  '../Settings/SettingsSubheader.css',
  // Joined with the viewer-topbar redesign: its new rules reach for the
  // border/mono tokens that get typed from memory and silently dropped.
  '../PDF/PDFViewer.css',
];

test('every design token used by the profile screens is actually defined', async () => {
  const variables = await readFile(new URL('../../styles/variables.css', import.meta.url), 'utf8');
  const defined = new Set(
    (variables.match(/^\s*(--[a-z0-9-]+)\s*:/gim) || [])
      .map(line => line.trim().replace(/\s*:$/, '')),
  );
  assert.ok(defined.size > 20, 'expected to have parsed the design tokens');

  const missing = [];
  for (const path of OWNED) {
    const stylesheet = await readFile(new URL(path, import.meta.url), 'utf8');
    // A property the stylesheet declares itself is not a missing token: it is
    // a local measure kept in one place so the rules that share it cannot
    // drift apart (the settings index rail sizes its rows and positions its
    // marker off one value). Only the ones nobody defines are the bug.
    const selfDefined = new Set(
      (stylesheet.match(/^\s*(--[a-z0-9-]+)\s*:/gim) || [])
        .map(line => line.trim().replace(/\s*:$/, '')),
    );
    for (const usage of stylesheet.match(/var\(\s*--[a-z0-9-]+/gi) || []) {
      const token = usage.replace(/var\(\s*/, '');
      if (defined.has(token) || selfDefined.has(token) || INJECTED_PROPERTIES.has(token)) continue;
      missing.push(`${path.split('/').pop()}: ${token}`);
    }
  }
  assert.deepEqual([...new Set(missing)], [], 'undefined design tokens are dropped silently');
});

test('every allowlisted property is really injected by the component that claims it', async () => {
  // Otherwise the allowlist is just a way to silence this check: a token that
  // stops being injected, or was never injected, would sit here looking
  // deliberate while the declaration it feeds is dropped in silence.
  for (const [property, componentPath] of INJECTED_PROPERTIES) {
    const component = await readFile(new URL(componentPath, import.meta.url), 'utf8');
    assert.ok(
      component.includes(`'${property}'`) || component.includes(`"${property}"`),
      `${property} is allowlisted as injected, but ${componentPath} never sets it`,
    );
  }
});

test('la fila de listas envuelve en móvil en vez de estrujar el título a una letra por línea', async () => {
  const css = await readFile(new URL('./ProfilePage.css', import.meta.url), 'utf8');
  // Los dos botones de la fila son rígidos y más anchos que la columna que
  // deja un teléfono; sin este wrap, flex: 1 + min-width: 0 + overflow-wrap:
  // anywhere parten el título por carácter (visto en un iPhone real,
  // 2026-08-29). El bloque estrecho debe envolver la fila y dar a las
  // acciones su propia línea completa.
  const narrow = css.match(/@media \(max-width: 640px\)\s*\{[\s\S]*?\n\}/);
  assert.ok(narrow, 'ProfilePage.css perdió su bloque de max-width: 640px');
  assert.match(narrow[0], /\.profile-pin-list li\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(narrow[0], /\.profile-pin-actions\s*\{[^}]*flex:\s*1 1 100%/);
});

/** A stylesheet without its comments, so prose cannot satisfy a rule check. */
function rules(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

test('the editor keeps a table of contents and a live preview beside the form', async () => {
  const css = rules(await readFile(new URL('./ProfilePage.css', import.meta.url), 'utf8'));
  // One grid for the whole screen: the heading sits in it, and the preview
  // rises to the heading's height instead of starting where the form does.
  assert.match(css, /\.profile-layout\s*\{[^}]*grid-template-columns:\s*var\(--profile-rail\) minmax\(0, 1fr\) var\(--profile-aside\)/);
  assert.match(css, /\.profile-layout\s*\{[^}]*grid-template-areas:\s*\n?\s*"head head preview"\s*\n?\s*"toc main preview"/);
  assert.match(css, /\.profile-layout > \.settings-subheader\s*\{[^}]*grid-area:\s*head/);
  assert.match(css, /\.profile-preview\s*\{[^}]*grid-area:\s*preview/);
  assert.match(css, /\.profile-toc-marker/);
  assert.match(css, /\.profile-preview-chrome/);
  const jsx = await readFile(new URL('./ProfilePage.jsx', import.meta.url), 'utf8');
  assert.match(jsx, /aria-label=\{copy\.tocLabel\}/);
  assert.match(jsx, /id="profile-identity"/);
  assert.match(jsx, /className="profile-inline-link" to="\/settings"/);
  // The heading is inside the grid, and the way to the public page moved
  // from a pill under the title to the preview card's foot.
  assert.match(jsx, /<div className="profile-layout">\s*<SettingsSubheader/);
  assert.match(jsx, /className="profile-preview-open"/);
  assert.doesNotMatch(jsx, /className="profile-public-link"/);
});

test('in the dark theme, what sits on the soft yellow is the ink that flips with it, not the fixed one', async () => {
  const css = rules(await readFile(new URL('./ProfilePage.css', import.meta.url), 'utf8'));
  // `--text-on-brand` is ink in both themes because the full yellow does not
  // flip; the SOFT yellow does (#fff4c9 -> #35290b), so ink on it measured
  // 1.30:1 in the dark theme -- the pinned state's label was invisible. Plain
  // `--text-primary` was legible but read as white on brown mud, and the ink
  // border framed the wash in white; `--text-on-brand-soft` is the brand
  // yellow on that side, and the line is the amber one (user feedback,
  // 2026-09-03).
  const pinned = css.match(/\.profile-pin-toggle\.is-pinned\s*\{[^}]*\}/);
  assert.ok(pinned, 'ProfilePage.css lost .profile-pin-toggle.is-pinned');
  assert.match(pinned[0], /color:\s*var\(--text-on-brand-soft\)/);
  assert.match(pinned[0], /border-color:\s*var\(--tint-amber-line\)/);
  assert.doesNotMatch(pinned[0], /--text-on-brand\)/);
  assert.doesNotMatch(pinned[0], /--text-primary/);
});

test('the list toggles answer the pointer: a hover, a press, and a pop when their state flips', async () => {
  const css = rules(await readFile(new URL('./ProfilePage.css', import.meta.url), 'utf8'));
  // Hover: an unmarked toggle firms its line; a marked one goes to the full
  // yellow with the fixed ink, the same pair the brand button uses.
  assert.match(css, /\.profile-pin-toggle:hover:not\(:disabled\)[^{]*\{[^}]*border-color:\s*var\(--border-strong\)/);
  const pinnedHover = css.match(/\.profile-pin-toggle\.is-pinned:hover:not\(:disabled\)[^{]*\{[^}]*\}/);
  assert.ok(pinnedHover, 'the marked toggle has no hover');
  assert.match(pinnedHover[0], /background:\s*var\(--brand-yellow\)/);
  assert.match(pinnedHover[0], /color:\s*var\(--text-on-brand\)/);
  // Press: the button gives under the pointer, and the shared rule names
  // `transform` so that give is eased rather than snapped.
  assert.match(css, /\.profile-pin-toggle:active:not\(:disabled\)[^{]*\{[^}]*transform:\s*scale\(0\.97\)/);
  const buttons = css.match(/\.profile-secondary,\s*\.profile-pin-toggle,\s*\.profile-primary\s*\{[^}]*\}/);
  assert.ok(buttons, 'ProfilePage.css lost the shared button rule');
  assert.match(buttons[0], /transform var\(--transition-fast\)/);
  // State flip: the toggle that just changed pops, the row it sits in flashes
  // with the same soft yellow the preview uses for a committed save, and the
  // pin button that appears when a list goes on the profile fades in.
  assert.match(css, /@keyframes profile-pin-pop/);
  assert.match(css, /\.profile-pin-toggle\.is-settling\s*\{[^}]*animation:\s*profile-pin-pop/);
  assert.match(css, /@keyframes profile-row-flash\s*\{[^}]*0%\s*\{\s*background:\s*var\(--bg-card\)/);
  assert.match(css, /\.profile-pin-list li\.is-flashing\s*\{[^}]*animation:\s*profile-row-flash/);
  assert.match(css, /@keyframes profile-pin-appear/);
  assert.match(css, /\.profile-pin-actions > button \+ button\s*\{[^}]*animation:\s*profile-pin-appear/);
  // And none of it moves for a reader who asked for less motion.
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[^{}]*\.profile-pin-toggle\.is-settling[^{}]*\{[^}]*animation:\s*none/);
  assert.ok(reduced, 'the pop has no prefers-reduced-motion guard');
  assert.match(reduced[0], /\.profile-pin-list li\.is-flashing/);
  assert.match(reduced[0], /\.profile-pin-actions > button \+ button/);
});

test('the pop marks the toggle the owner just changed, not every marked toggle on load', async () => {
  const jsx = await readFile(new URL('./ProfilePage.jsx', import.meta.url), 'utf8');
  // A keyframe on `.is-pinned` would fire for every already-pinned list when
  // the page opens. The class comes from state set by the two handlers once
  // their change is on screen, and leaves when the animation ends.
  assert.match(jsx, /const \[settling, setSettling\] = useState\(null\)/);
  assert.match(jsx, /setSettling\(\{ shareId: list\.shareId, kind: 'attribution' \}\)/);
  assert.match(jsx, /setSettling\(\{ shareId, kind: 'pin' \}\)/);
  assert.match(jsx, /onAnimationEnd=\{settleDone\}/);
  assert.match(jsx, /is-settling/);
  assert.match(jsx, /is-flashing/);
  // A failed pin rolls its state back, and must not pop as if it had landed.
  const pin = jsx.slice(jsx.indexOf('const togglePin'), jsx.indexOf('const unpublishProfile'));
  assert.ok(pin.indexOf('await savePinnedShareIds') < pin.indexOf("kind: 'pin'"), 'the pin pops before the save lands');
});

test('the primary and the danger buttons answer the pointer too', async () => {
  const css = rules(await readFile(new URL('./ProfilePage.css', import.meta.url), 'utf8'));
  const primary = css.match(/\.profile-primary:hover:not\(:disabled\)[^{]*\{[^}]*\}/);
  assert.ok(primary, 'the primary button has no hover');
  assert.match(primary[0], /background:\s*var\(--accent-primary-hover\)/);
  assert.match(primary[0], /box-shadow:\s*inset 0 -4px 0 var\(--brand-yellow\)/);
  assert.match(css, /\.profile-primary:active:not\(:disabled\)[^{]*\{[^}]*transform:\s*scale\(0\.97\)/);
  assert.match(css, /\.profile-danger-button:active:not\(:disabled\)\s*\{[^}]*transform:\s*scale\(0\.97\)/);
  assert.match(css, /\.profile-danger-button\s*\{[^}]*transition:[^;]*transform var\(--transition-fast\)/);
});

test('unpublishing rebuilds the form, and the rebuilt form rises the way the page did', async () => {
  const css = rules(await readFile(new URL('./ProfilePage.css', import.meta.url), 'utf8'));
  const jsx = await readFile(new URL('./ProfilePage.jsx', import.meta.url), 'utf8');
  // The sections that vanish when the profile goes are replaced by the
  // create-a-profile form; keyed on the rebirth it remounts and enters with
  // the page's own rise instead of flicking into place.
  assert.match(jsx, /const \[reborn, setReborn\] = useState\(false\)/);
  assert.match(jsx, /key=\{reborn \? 'form-reborn' : 'form'\}/);
  assert.match(jsx, /className=\{`profile-form\$\{reborn \? ' is-reborn' : ''\}`\}/);
  const unpublish = jsx.slice(jsx.indexOf('const unpublishProfile'), jsx.indexOf('if (!user) return null'));
  assert.match(unpublish, /setReborn\(true\)/);
  assert.match(css, /\.profile-form\.is-reborn\s*\{[^}]*animation:\s*profile-rise/);
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[^{}]*\.profile-form\.is-reborn[^{}]*\{[^}]*animation:\s*none/);
  assert.ok(reduced, 'the rebuilt form has no prefers-reduced-motion guard');
});

test('the editor names its transitions and guards its entrance for reduced motion', async () => {
  const css = rules(await readFile(new URL('./ProfilePage.css', import.meta.url), 'utf8'));
  // global.css animates `all` on every button at 250ms -- layout included,
  // which is the "soft button" feel. The three button classes of this page
  // name what moves instead.
  const buttons = css.match(/\.profile-secondary,\s*\.profile-pin-toggle,\s*\.profile-primary\s*\{[^}]*\}/);
  assert.ok(buttons, 'ProfilePage.css lost the shared button rule');
  assert.match(buttons[0], /transition:\s*background var\(--transition-fast\)/);
  assert.doesNotMatch(buttons[0], /transition:\s*all/);
  // The grid's parts rise a beat apart; a reader who asked for less motion
  // gets them at once.
  assert.match(css, /\.profile-layout > \*\s*\{[^}]*animation:\s*profile-rise/);
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[^{}]*\.profile-layout > \*[^{}]*\{[^}]*animation:\s*none/);
  assert.ok(reduced, 'the staggered entrance has no prefers-reduced-motion guard');
});

test('the dark theme gets stronger lines for fields and rules, the light theme keeps its hairlines', async () => {
  const css = rules(await readFile(new URL('./ProfilePage.css', import.meta.url), 'utf8'));
  // Measured 2026-09-03: --border-default sits at 1.37:1 on --bg-card in the
  // dark theme and the cards themselves at 1.06:1 on the page, so fields and
  // section rules all but vanished. The page keeps two local lines: the
  // structural rule and the field boundary, each redefined for the dark side.
  const light = css.match(/\.profile-page\s*\{[^}]*\}/);
  assert.ok(light, 'ProfilePage.css lost .profile-page');
  assert.match(light[0], /--profile-rule:\s*var\(--border-default\)/);
  assert.match(light[0], /--profile-line-field:\s*var\(--border-default\)/);
  const dark = css.match(/:root\[data-theme='dark'\] \.profile-page\s*\{[^}]*\}/);
  assert.ok(dark, 'ProfilePage.css has no dark-theme block for .profile-page');
  assert.match(dark[0], /--profile-rule:\s*var\(--border-strong\)/);
  assert.match(dark[0], /--profile-line-field:\s*color-mix\(in srgb, var\(--text-tertiary\) 70%, var\(--bg-card\)\)/);
  // And the rules that draw structure use them rather than the raw tokens.
  assert.match(css, /\.profile-section\s*\{[^}]*border-top:\s*1px solid var\(--profile-rule\)/);
  assert.match(css, /\.profile-field textarea\s*\{[^}]*border:\s*1px solid var\(--profile-line-field\)/);
});

test('the handle is one box with the @ inside it, not a box within a box', async () => {
  const css = rules(await readFile(new URL('./ProfilePage.css', import.meta.url), 'utf8'));
  // The wrapper used to draw a border around the @ and the field while the
  // input drew its own inside. At rest both were hairlines; on focus the
  // global text-field rule in styles/global.css -- (0,4,1), which no ordinary
  // component override outranks -- painted an inset hairline on the inner
  // input, framing the field without its @.
  const wrapper = css.match(/\.profile-handle-input\s*\{[^}]*\}/);
  assert.ok(wrapper, 'ProfilePage.css lost .profile-handle-input');
  assert.match(wrapper[0], /position:\s*relative/);
  assert.doesNotMatch(wrapper[0], /border|background/);
  assert.doesNotMatch(css, /\.profile-handle-input:focus-within/);
  // The prefix is overlaid inside the field's own box, and must not swallow
  // the click that focuses it.
  const prefix = css.match(/\.profile-handle-input > span\s*\{[^}]*\}/);
  assert.ok(prefix, 'ProfilePage.css lost the @ prefix rule');
  assert.match(prefix[0], /position:\s*absolute/);
  assert.match(prefix[0], /pointer-events:\s*none/);
  assert.match(css, /\.profile-field \.profile-handle-input input\s*\{[^}]*padding-left:\s*calc\(/);
  // With one box there is nothing left to override, so the field keeps the
  // app's own focus treatment.
  assert.doesNotMatch(css, /\.profile-handle-input input:focus/);
});
