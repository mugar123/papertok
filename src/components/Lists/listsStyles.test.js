import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * A class name is a contract between a component and its stylesheet, and it is
 * the only contract in this codebase that nothing checks: a `className` nobody
 * styles renders a bare, unstyled element, and a rule nobody renders is dead
 * weight. Neither produces a warning, a lint error or a build failure.
 *
 * This is not hypothetical. The save-and-organize modal was rewritten to
 * confirm-on-save — a save bar, a discard confirmation, an inline error, a tag
 * chip editor, a loading skeleton, a retry button — and its stylesheet was
 * never rewritten with it. Nineteen classes the JSX rendered had no rule at
 * all: the Save button was an unstyled `<button>`, the skeleton was two divs of
 * zero height, and the tag editor was a bare input. Meanwhile eight rules for
 * the deleted inline create-list form were still shipping.
 *
 * `profileStyles.test.js` checks that every token a stylesheet reaches for is
 * defined. This is the same idea one level up: that every class a component
 * reaches for is defined, and that nothing is left behind.
 */

/**
 * Class names that legitimately appear on only one side.
 *
 * `save-modal-tags-label` is an `id`, not a class — it wires the tag input to
 * its label with `aria-labelledby`. Anything else added here needs a reason
 * written next to it, or the entry becomes cover for the very drift this test
 * exists to catch.
 */
const NOT_CLASS_NAMES = new Set([
  'save-modal-tags-label',
  // Both are `id`s, not classes: each wires a picker's radiogroup to its
  // visible label with `aria-labelledby`.
  'create-list-icon-label',
  'create-list-color-label',
  // `id`s again: the note textarea and the name input, each wired to its
  // <label> with `htmlFor`. The fields themselves are ui/textarea.jsx and
  // ui/input.jsx and carry no class of their own.
  'save-modal-note',
  'create-list-name',
]);

const PAIRS = [
  { prefix: 'save-modal', jsx: './SaveToListModal.jsx', css: './SaveToListModal.css' },
  { prefix: 'create-list', jsx: './CreateListDialog.jsx', css: './CreateListDialog.css' },
];

for (const { prefix, jsx, css } of PAIRS) {
  const pattern = new RegExp(`${prefix}[a-z0-9-]*`, 'g');

  test(`${prefix}: every class the component renders has a rule`, async () => {
    const component = await readFile(new URL(jsx, import.meta.url), 'utf8');
    const stylesheet = await readFile(new URL(css, import.meta.url), 'utf8');

    const rendered = new Set([...component.matchAll(pattern)].map(match => match[0]));
    const styled = new Set(
      [...stylesheet.matchAll(new RegExp(`\\.(${prefix}[a-z0-9-]*)`, 'g'))].map(match => match[1]),
    );
    assert.ok(rendered.size > 5, 'expected to have parsed the component');

    const unstyled = [...rendered]
      .filter(name => !styled.has(name) && !NOT_CLASS_NAMES.has(name))
      .sort();
    assert.deepEqual(unstyled, [], `classes rendered with no rule behind them: ${unstyled.join(', ')}`);
  });

  test(`${prefix}: every rule in the stylesheet is still rendered`, async () => {
    const component = await readFile(new URL(jsx, import.meta.url), 'utf8');
    const stylesheet = await readFile(new URL(css, import.meta.url), 'utf8');

    const rendered = new Set([...component.matchAll(pattern)].map(match => match[0]));
    const styled = new Set(
      [...stylesheet.matchAll(new RegExp(`\\.(${prefix}[a-z0-9-]*)`, 'g'))].map(match => match[1]),
    );

    const orphaned = [...styled].filter(name => !rendered.has(name)).sort();
    assert.deepEqual(orphaned, [], `rules for markup that no longer exists: ${orphaned.join(', ')}`);
  });
}

/**
 * Rule 4 of design.md: radii come from the tokens, and `--radius-full` is for
 * avatars and meters only. A literal `50%` or a pixel radius bypasses the
 * token and cannot be changed from `variables.css`, which is the trap the
 * design system's own notes call out ("tokens don't reach hardcoded values").
 */
test('the lists surfaces carry no hardcoded radius or colour literal', async () => {
  const offences = [];
  for (const { css } of PAIRS) {
    const stylesheet = await readFile(new URL(css, import.meta.url), 'utf8');
    stylesheet.split('\n').forEach((line, index) => {
      const where = `${css.split('/').pop()}:${index + 1}`;
      // A bare `0` is a reset, not a radius; anything carrying a unit is one.
      if (/border-radius:[^;]*\d+(px|rem|em|%)/.test(line)) offences.push(`${where} hardcoded radius`);
      // The scrim is the one documented literal (design.md, "Overlay
      // surfaces": `rgba(17,19,24,0.4)` + blur), so ::backdrop is exempt.
      if (/#[0-9a-f]{3,8}\b/i.test(line) && !/backdrop/.test(line)) {
        offences.push(`${where} hardcoded colour`);
      }
    });
  }
  assert.deepEqual(offences, [], offences.join('; '));
});
