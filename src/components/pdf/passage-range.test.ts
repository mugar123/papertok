import '../../../tests/dom/dom-environment.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { annotationRange, occurrenceBefore, overlapping, passageFromRange, quoteOffsets, replacingHighlights } from './passage-range.ts';
import { MAX_NOTE_LENGTH } from '../../services/user-highlight-service.ts';

test('a quote is found across the line breaks and runs of spaces of the page text', () => {
  const text = 'The model\n   scored better than earlier  systems.';
  const at = quoteOffsets(text, 'model scored better');
  assert.deepEqual(at, [4, 26]);
  assert.equal(text.slice(...at), 'model\n   scored better');
});

test('a quote that is no longer in the text is not found', () => {
  assert.equal(quoteOffsets('The model scored better.', 'scored worse'), null);
  assert.equal(quoteOffsets('The model scored better.', '   '), null);
});

test('a repeated quote is found at the occurrence that was marked', () => {
  const text = 'the model fails. Later,\n the  model succeeds.';
  const second = quoteOffsets(text, 'the model', 1);
  assert.ok(second);
  assert.equal(text.slice(...second), 'the  model');
  assert.equal(quoteOffsets(text, 'the model', 2), null);
});

test('the occurrence counts the same words that start before the selection', () => {
  const text = 'the model fails, and the model succeeds';
  assert.equal(occurrenceBefore(text, 'the model', 0), 0);
  assert.equal(occurrenceBefore(text, 'the model', text.lastIndexOf('the model')), 1);
});

test('a passage overlaps the highlights it shares words with, and only those', () => {
  const text = 'applied in increasingly flexible and task-agnostic ways for downstream transfer';
  const old = { quote: 'task-agnostic ways' };
  const touching = { quote: 'for downstream' };
  assert.deepEqual(overlapping(text, { quote: 'and task-agnostic ways for' }, [old, touching]), [old, touching]);
  assert.deepEqual(overlapping(text, { quote: 'agnostic' }, [old, touching]), [old]);
  assert.deepEqual(overlapping(text, { quote: 'increasingly flexible' }, [old, touching]), []);
});

test('the same words elsewhere in the paragraph are a different passage', () => {
  const text = 'the model fails, and the model succeeds';
  assert.deepEqual(overlapping(text, { quote: 'the model', occurrence: 1 }, [{ quote: 'the model', occurrence: 0 }]), []);
});

test('a highlight over others keeps their notes, and replaces none when the notes would not fit one', () => {
  const old = [{ id: 'a', note: 'First thought.' }, { id: 'b', note: '' }];
  assert.deepEqual(replacingHighlights('New thought.', old), { note: 'New thought.\n\nFirst thought.', replaced: old });
  const long = [{ id: 'c', note: 'x'.repeat(MAX_NOTE_LENGTH - 5) }];
  assert.deepEqual(replacingHighlights('New thought.', long), { note: 'New thought.', replaced: [] });
});

test('a selection into a later block keeps where it ends, and its saved range covers every block between', (t) => {
  // jsdom has no CSS namespace (the blocks are looked up by escaped id), and its NodeFilter lives on its window.
  if (typeof CSS === 'undefined') {
    Object.defineProperty(globalThis, 'CSS', { configurable: true, value: { escape: (value: string) => value } });
    t.after(() => Reflect.deleteProperty(globalThis, 'CSS'));
  }
  if (typeof NodeFilter === 'undefined') {
    Object.defineProperty(globalThis, 'NodeFilter', { configurable: true, value: (window as unknown as { NodeFilter: typeof NodeFilter }).NodeFilter });
    t.after(() => Reflect.deleteProperty(globalThis, 'NodeFilter'));
  }
  // Nor does jsdom lay out a range; the box only places the editor.
  const RangeType = (window as unknown as { Range: typeof Range }).Range;
  if (!('getBoundingClientRect' in RangeType.prototype)) {
    Object.defineProperty(RangeType.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({}) });
    t.after(() => Reflect.deleteProperty(RangeType.prototype, 'getBoundingClientRect'));
  }
  const root = document.createElement('div');
  root.innerHTML = '<p data-passage="b1">First block ends here.</p><p data-passage="b2">Middle block whole.</p><p data-passage="b3">Last block starts and goes on.</p>';
  document.body.append(root);
  t.after(() => root.remove());
  const [first, , last] = [...root.querySelectorAll('p')].map(block => block.firstChild!);
  const range = document.createRange();
  range.setStart(first, 6);
  range.setEnd(last, 17);

  const passage = passageFromRange(root, range);
  assert.equal(passage?.sectionId, 'b1');
  assert.equal(passage?.quote, 'block ends here.');
  assert.equal(passage?.endSectionId, 'b3');
  assert.equal(passage?.endQuote, 'Last block starts');
  assert.equal(annotationRange(root, passage)?.toString(), 'block ends here.Middle block whole.Last block starts');

  const inside = document.createRange();
  inside.setStart(first, 6);
  inside.setEnd(first, 16);
  assert.equal(passageFromRange(root, inside)?.endSectionId, undefined, 'a selection inside one block names no end');
});
