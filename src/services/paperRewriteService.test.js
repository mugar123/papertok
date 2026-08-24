import assert from 'node:assert/strict';
import test from 'node:test';
import { createNdjsonParser } from './paperRewriteService.js';

test('assembles events only once their line closes', () => {
  const parser = createNdjsonParser();
  assert.deepEqual(parser.push('{"type":"meta","level":"unive'), []);
  const events = parser.push('rsity"}\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'meta');
  assert.equal(events[0].level, 'university');
});

test('emits several events arriving in one chunk', () => {
  const parser = createNdjsonParser();
  const events = parser.push([
    '{"type":"meta"}',
    '{"type":"section","index":0}',
    '{"type":"section","index":1}',
    '',
  ].join('\n'));
  assert.deepEqual(events.map(event => event.type), ['meta', 'section', 'section']);
});

test('skips a corrupt line rather than losing the stream', () => {
  const parser = createNdjsonParser();
  const events = parser.push('{"type":"section"}\nnot json\n{"type":"done"}\n');
  assert.deepEqual(events.map(event => event.type), ['section', 'done']);
});

test('flush recovers a final line with no trailing newline', () => {
  const parser = createNdjsonParser();
  assert.deepEqual(parser.push('{"type":"done","sectionCount":3}'), []);
  const flushed = parser.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].sectionCount, 3);
});

test('flush on an empty buffer yields nothing', () => {
  const parser = createNdjsonParser();
  parser.push('{"type":"done"}\n');
  assert.deepEqual(parser.flush(), []);
});

test('a byte split inside a multi-line chunk keeps order', () => {
  const parser = createNdjsonParser();
  const first = parser.push('{"type":"section","index":0}\n{"type":"sec');
  assert.equal(first.length, 1);
  const second = parser.push('tion","index":1}\n');
  assert.equal(second.length, 1);
  assert.equal(second[0].index, 1);
});
