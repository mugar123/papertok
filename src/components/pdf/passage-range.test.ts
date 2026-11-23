import test from 'node:test';
import assert from 'node:assert/strict';
import { occurrenceBefore, overlapping, quoteOffsets, replacingHighlights } from './passage-range.ts';
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
