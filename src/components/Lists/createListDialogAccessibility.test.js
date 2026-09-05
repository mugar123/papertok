import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The list-name field's error, tied to the field that caused it (WCAG 3.3.1).
 *
 * `state.error` is set from `createListFormReducer`'s `failed` action, reached
 * when `onCreate`/`onSave` throws -- the one thing the dialog's single text
 * field can be blamed for. The error paragraph already carried
 * `role="alert"`, so it was announced when it appeared, but it named no field
 * and nothing pointed back to it from the input: a screen reader user who had
 * already tabbed away, or who tabs back into the name field afterwards, had
 * no programmatic way to learn it was in error.
 */

const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

const read = async (path) => stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));

test('a failed create/save is tied to the name field, not only announced', async () => {
  const jsx = await read('./CreateListDialog.jsx');

  const input = jsx.match(/<(?:input|Input)\b[\s\S]*?\/>/);
  assert.ok(input, 'the list-name input changed shape; update this test alongside it');
  assert.match(
    input[0],
    /className="create-list-input"/,
    'the matched <input> is no longer the list-name field; update this test alongside it',
  );
  assert.match(
    input[0],
    /aria-invalid=\{state\.error \? 'true' : undefined\}/,
    'the list-name input no longer flags aria-invalid when the create/save request fails.',
  );
  const describedBy = input[0].match(/aria-describedby=\{state\.error \? (\w+) : undefined\}/);
  assert.ok(
    describedBy,
    'the list-name input no longer points aria-describedby at the error message id.',
  );

  const errorParagraph = jsx.match(/<p[^>]*className="create-list-error"[^>]*>/);
  assert.ok(errorParagraph, 'the create-list error paragraph changed shape; update this test alongside it');
  assert.match(
    errorParagraph[0],
    new RegExp(`id=\\{${describedBy[1]}\\}`),
    'the create-list error paragraph no longer carries the id aria-describedby points at '
    + '-- a screen reader user back in the name field after "It could not be created" has '
    + 'no programmatic link to that text, only the one-time role="alert" announcement.',
  );
  assert.match(errorParagraph[0], /role="alert"/, 'the create-list error paragraph lost role="alert"');
});
