import test from 'node:test';
import assert from 'node:assert/strict';
import { occurrenceBefore, overlapping, quoteOffsets, replacementHighlights, replacingHighlights } from './passage-range.ts';

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


test('replacing a highlight cannot consume another level, paragraph, section or AI answer', () => {
  const passage = { sectionId: 'intro', paragraphIndex: 0, quote: 'a shared phrase' };
  const base = { ...passage, kind: 'user' as const, level: 'researcher' };
  const candidates = [
    { ...base, id: 'visible' }, { ...base, id: 'beginner', level: 'beginner' },
    { ...base, id: 'other-paragraph', paragraphIndex: 1 }, { ...base, id: 'other-section', sectionId: 'results' },
    { ...base, id: 'answer', kind: 'ai' as const },
  ];
  assert.deepEqual(replacementHighlights('This has a shared phrase.', passage, candidates, 'researcher').map(item => item.id), ['visible']);
  assert.deepEqual(replacementHighlights('a shared phrase and a shared phrase', passage, candidates, 'researcher'), []);
});


test('merging notes preserves all text or refuses before the original is overwritten', () => {
  const notes = [{ id: 'a', note: 'First note' }, { id: 'b', note: 'Second note' }];
  assert.deepEqual(replacingHighlights('New note', notes), { note: 'New note\n\nFirst note\n\nSecond note', replaced: notes });
  assert.equal(replacingHighlights('', [{ note: 'a'.repeat(800) }, { note: 'b'.repeat(800) }]), null);
  assert.equal(replacingHighlights('New note', [{ id: 'same-highlight', note: 'a'.repeat(1200) }]), null);
  assert.deepEqual(replacingHighlights('', [{ note: 'a'.repeat(1200) }]), { note: 'a'.repeat(1200), replaced: [{ note: 'a'.repeat(1200) }] });
});
