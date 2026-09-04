import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The composer textarea's name, and its error, tied to the field (WCAG 3.3.2
 * and 3.3.1).
 *
 * The composer's only visible label used to be its own placeholder
 * ("Add a comment..." / "Añade un comentario..."), which vanishes the moment
 * anyone types -- not a label. `composerError` (set from `explainDenial` when
 * posting or editing fails: throttled, frozen, or a bare write failure) was
 * announced through `role="alert"` but never tied to the field it is about,
 * so a screen reader user back in the textarea after the alert had no
 * programmatic way to hear why it was flagged.
 */

const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

const read = async (path) => stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));

test('the composer textarea is named by more than its placeholder', async () => {
  const jsx = await read('./CommentsSheet.jsx');

  const textarea = jsx.match(/<textarea\b[\s\S]*?\/>/);
  assert.ok(textarea, 'the composer textarea changed shape; update this test alongside it');
  assert.match(
    textarea[0],
    /className="comments-composer-input"/,
    'the matched <textarea> is no longer the composer field; update this test alongside it',
  );
  assert.match(
    textarea[0],
    /placeholder=\{text\(COPY\.placeholder\)\}/,
    'the composer lost its placeholder; update this test alongside it',
  );
  assert.match(
    textarea[0],
    /aria-label=\{text\(COPY\.composerLabel\)\}/,
    'the composer textarea lost its aria-label -- its placeholder is its only other '
    + 'name, and a placeholder disappears from the accessibility tree the moment '
    + 'anyone types into the field.',
  );

  assert.match(
    jsx,
    /composerLabel:\s*\{\s*es:\s*'[^']+',\s*en:\s*'[^']+'\s*\}/,
    'the bilingual COPY.composerLabel entry the aria-label above reads from is gone.',
  );
});

test('a failed post or edit is tied to the composer field, not only announced', async () => {
  const jsx = await read('./CommentsSheet.jsx');

  const textarea = jsx.match(/<textarea\b[\s\S]*?\/>/)[0];
  assert.match(
    textarea,
    /aria-invalid=\{composerError \? 'true' : undefined\}/,
    'the composer textarea no longer flags aria-invalid when composerError is set.',
  );
  const describedBy = textarea.match(/aria-describedby=\{composerError \? (\w+) : undefined\}/);
  assert.ok(
    describedBy,
    'the composer textarea no longer points aria-describedby at the error message id.',
  );

  const errorParagraph = jsx.match(/<p[^>]*className="comments-composer-error"[^>]*>/);
  assert.ok(errorParagraph, 'the composer error paragraph changed shape; update this test alongside it');
  assert.match(
    errorParagraph[0],
    new RegExp(`id=\\{${describedBy[1]}\\}`),
    `the composer error paragraph no longer carries id={${describedBy[1]}} -- `
    + 'aria-describedby then points at nothing, and a screen reader user who tabs back '
    + 'to the field after "It could not be posted" (or the throttled/frozen message) has '
    + 'no programmatic link to that text, only the one-time role="alert" announcement.',
  );
  assert.match(errorParagraph[0], /role="alert"/, 'the composer error paragraph lost role="alert"');
});
