import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAnnotationPrompt,
  isAnnotationLevel,
  MAX_NOTE_CHARS,
  parseAnnotationPayload,
} from './ai-annotation.js';

const PASSAGE = {
  paper: { title: 'Correlators of Worldline Proper Length' },
  quote: 'that quantity stops being a number',
  context: 'The authors compute how much proper time elapses, and find that that quantity stops being a number as soon as quantum gravity comes into play.',
  level: 'university',
};

function payloadOf(text) {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

test('the prompt carries the passage and the paragraph, and says which is which', () => {
  const prompt = buildAnnotationPrompt(PASSAGE);
  assert.match(prompt, /Correlators of Worldline Proper Length/);
  assert.match(prompt, /that quantity stops being a number/);
  assert.match(prompt, /context only/);
  // Explaining the paragraph instead of the selection is the failure this
  // labelling exists to prevent.
  assert.match(prompt, /Explain WHAT THAT PASSAGE MEANS/);
});

test('the level changes who it is written for', () => {
  const beginner = buildAnnotationPrompt({ ...PASSAGE, level: 'beginner' });
  const researcher = buildAnnotationPrompt({ ...PASSAGE, level: 'researcher' });
  assert.match(beginner, /no training in the field/);
  assert.match(researcher, /standard vocabulary/);
});

test('a legacy Spanish language request still gets an English prompt', () => {
  const prompt = buildAnnotationPrompt({ ...PASSAGE, language: 'es' });
  assert.match(prompt, /Explain WHAT THAT PASSAGE MEANS/);
  assert.doesNotMatch(prompt, /Explica|FRAGMENTO/);
});

test('only the three reader levels are levels', () => {
  assert.equal(isAnnotationLevel('beginner'), true);
  assert.equal(isAnnotationLevel('university'), true);
  assert.equal(isAnnotationLevel('researcher'), true);
  assert.equal(isAnnotationLevel('expert'), false);
  assert.equal(isAnnotationLevel('constructor'), false);
});

test('the answer comes back as one paragraph of plain text', () => {
  const note = parseAnnotationPayload(payloadOf('  Antes medías un tiempo.\n\nAhora sale un abanico.  '));
  assert.equal(note, 'Antes medías un tiempo. Ahora sale un abanico.');
});

test('markdown the model reached for anyway is stripped, not refused', () => {
  const note = parseAnnotationPayload(payloadOf('- **Primero** esto\n- Luego lo otro'));
  assert.equal(note, 'Primero esto Luego lo otro');
});

test('quotation marks wrapped around the whole answer come off', () => {
  assert.equal(parseAnnotationPayload(payloadOf('"Significa otra cosa"')), 'Significa otra cosa');
  assert.equal(parseAnnotationPayload(payloadOf('«Significa otra cosa»')), 'Significa otra cosa');
});

test('a long answer is cut to what a margin can hold', () => {
  const note = parseAnnotationPayload(payloadOf('palabra '.repeat(400)));
  assert.equal(note.length, MAX_NOTE_CHARS);
});

test('a silent model is an error, not an empty annotation', () => {
  assert.throws(() => parseAnnotationPayload(payloadOf('   ')), /AI_EMPTY_RESPONSE/);
  assert.throws(() => parseAnnotationPayload({}), /AI_EMPTY_RESPONSE/);
  assert.throws(() => parseAnnotationPayload({ candidates: [{}] }), /AI_EMPTY_RESPONSE/);
});

test('a multi-part answer is joined rather than truncated at the first part', () => {
  const note = parseAnnotationPayload({
    candidates: [{ content: { parts: [{ text: 'Primera mitad ' }, { text: 'y segunda.' }] } }],
  });
  assert.equal(note, 'Primera mitad y segunda.');
});
