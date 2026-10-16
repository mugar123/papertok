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
  ['--stagger-index', '../components/Lists/ListsPage.jsx'],
  ['--loading-row-index', '../components/Search/SearchPage.jsx'],
  ['--search-item-index', '../components/Search/SearchPage.jsx'],
  // A row takes the research field of its paper, the same way a card or an
  // entity header does, so its rules are tinted by the data rather than by a
  // decorative default. The lists page sets it per row.
  ['--area-accent', '../components/Lists/ListsPage.jsx'],
  // A list's colour is the owner's choice, so it cannot be a token: the lists
  // page resolves it per list and sets it on the card. It is deliberately not
  // `--area-accent` — inside an open list both appear at once, the header
  // wearing the list's colour and each row its paper's field.
  ['--list-accent', '../components/Lists/ListsPage.jsx'],
]);

const CHECKED_STYLESHEETS = [
  // Added with the save-and-organize fix, which introduced `.save-modal-retry`.
  // The file was already clean, so this costs nothing and stops the next token
  // added here from being the one nobody notices.
  '../components/Lists/SaveToListModal.css',
  // Added once its `--bg-hover` was dealt with: the token was defined nowhere,
  // so `.lists-retry-btn:hover` had no background at all — a live instance of
  // exactly this bug, found by the sweep rather than by looking at the page.
  // It now uses `--bg-glass-hover`, like every other hover in the app.
  '../components/Lists/ListsPage.css',
  // Added when the public list page gained the share button and the navbar
  // offsets: the file was already clean, and the tokens the new rules reach for
  // (`--nav-height`, `--accent-success`, `--accent-danger`) are exactly the kind
  // that get typed from memory and silently dropped.
  '../components/Lists/PublicListPage.css',
  // Joined once its dead `--text-muted` (used seven times, defined nowhere,
  // every declaration silently dropped) was replaced with the existing
  // `--text-tertiary` in the redesign pass. Its two locally-injected
  // properties are declared above.
  '../components/Search/SearchPage.css',
  // Both were already clean when checked during the redesign pass; adding them
  // costs nothing and covers the settings surface too.
  '../components/Settings/SettingsPage.css',
  '../components/Settings/FollowingSettingsPage.css',
  // The heading shared by every /settings/* sub-page.
  '../components/Settings/SettingsSubheader.css',
  // Joined with the viewer-topbar redesign: its new rules reach for the
  // border/mono tokens that get typed from memory and silently dropped.
  '../components/PDF/PDFViewer.css',
];

test('every design token the checked stylesheets use is actually defined', async () => {
  const variables = await readFile(new URL('./variables.css', import.meta.url), 'utf8');
  const defined = new Set(
    (variables.match(/^\s*(--[a-z0-9-]+)\s*:/gim) || [])
      .map(line => line.trim().replace(/\s*:$/, '')),
  );
  assert.ok(defined.size > 20, 'expected to have parsed the design tokens');

  const missing = [];
  for (const path of CHECKED_STYLESHEETS) {
    const stylesheet = await readFile(new URL(path, import.meta.url), 'utf8');
    // A property the stylesheet declares itself is not a missing token: it is
    // a local measure kept in one place so the rules that share it cannot
    // drift apart (the settings pages draw every panel edge and row rule off
    // one line). Only the ones nobody defines are the bug.
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
