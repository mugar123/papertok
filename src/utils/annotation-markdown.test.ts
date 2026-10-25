import test from 'node:test';
import assert from 'node:assert/strict';
import { annotationMarkdown } from './annotation-markdown.ts';

test('a note copies as an italic blockquote followed by the note', () => {
  assert.equal(
    annotationMarkdown({ quote: 'Small errors pile up.', note: 'Same as in RL.' }),
    '> *Small errors pile up.*\n\nSame as in RL.',
  );
});

test('a multi-line passage keeps one quoted paragraph per line', () => {
  assert.equal(
    annotationMarkdown({ quote: 'First line.\nSecond line.', note: '' }),
    '> *First line.*\n>\n> *Second line.*',
  );
});

test('asterisks and underscores in the passage do not break the italics', () => {
  assert.equal(
    annotationMarkdown({ quote: 'a*b and snake_case', note: null }),
    '> *a\\*b and snake\\_case*',
  );
});

test('a highlight without a note copies only the passage', () => {
  assert.equal(annotationMarkdown({ quote: 'Only this.' }), '> *Only this.*');
});
