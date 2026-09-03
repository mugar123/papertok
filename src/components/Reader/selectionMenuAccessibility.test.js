import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The annotation textarea's name (WCAG 3.3.2).
 *
 * Its visible label used to be a bare `<span className="rd-menu-label">`
 * sitting next to the field, with no `htmlFor` and no association of any
 * kind -- a screen reader landing on the field announced only its type, with
 * nothing naming what the words below the pen icon are for. The fix turns
 * the span into a real `<label>` wired to the textarea by id.
 */

const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

const read = async (path) => stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));

test('the note textarea is named by a real <label>, not a floating span', async () => {
  const jsx = await read('./SelectionMenu.jsx');

  assert.doesNotMatch(
    jsx,
    /<span className="rd-menu-label">/,
    '"rd-menu-label" is back to being a <span> -- a span next to a field carries no '
    + 'programmatic association at all, however clearly its text reads on screen.',
  );

  const label = jsx.match(/<label className="rd-menu-label"[^>]*>/);
  assert.ok(label, 'the "rd-menu-label" element changed shape; update this test alongside it');
  const fieldId = label[0].match(/htmlFor=\{(\w+)\}/);
  assert.ok(
    fieldId,
    'the note label lost its htmlFor -- without it the <label> has no association a '
    + 'screen reader can use, wrapping the field or not.',
  );

  const textarea = jsx.match(/<textarea\b[\s\S]*?\/>/);
  assert.ok(textarea, 'the note textarea changed shape; update this test alongside it');
  assert.match(
    textarea[0],
    /className="rd-menu-input"/,
    'the matched <textarea> is no longer the note field (className="rd-menu-input"); '
    + 'update this test alongside it',
  );
  assert.match(
    textarea[0],
    new RegExp(`id=\\{${fieldId[1]}\\}`),
    `the note textarea no longer carries id={${fieldId[1]}} -- the label's htmlFor then `
    + 'points at nothing, and the field goes back to having no accessible name once its '
    + 'placeholder is typed over (a placeholder is not a label: it disappears from the '
    + 'accessibility tree the moment the field holds text).',
  );
});
