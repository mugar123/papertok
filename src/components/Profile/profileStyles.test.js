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

test('in the dark theme, what sits on the soft yellow is the flipping ink, not the fixed one', async () => {
  const css = rules(await readFile(new URL('./ProfilePage.css', import.meta.url), 'utf8'));
  // `--text-on-brand` is ink in both themes because the full yellow does not
  // flip; the SOFT yellow does (#fff4c9 -> #35290b), so ink on it measured
  // 1.30:1 in the dark theme -- the pinned state's label was invisible.
  const pinned = css.match(/\.profile-pin-toggle\.is-pinned\s*\{[^}]*\}/);
  assert.ok(pinned, 'ProfilePage.css lost .profile-pin-toggle.is-pinned');
  assert.match(pinned[0], /color:\s*var\(--text-primary\)/);
  assert.doesNotMatch(pinned[0], /--text-on-brand/);
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
  assert.match(css, /\.profile-handle-input\s*\{[^}]*border:\s*1px solid var\(--profile-line-field\)/);
});
