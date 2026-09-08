import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { matchesAuthorName } from './authorNameMatch.js';

test('the same person written two ways still matches', () => {
  assert.ok(matchesAuthorName('Nicolás Cuello', 'Nicolas Cuello'), 'accents are not a difference');
  assert.ok(matchesAuthorName('A. M. Gavrilik', 'Alexandre M Gavrilik'), 'an initial matches the name it abbreviates');
  assert.ok(matchesAuthorName('Jean-Pierre Dupont', 'Jean Pierre Dupont'), 'a hyphen is a space');
  assert.ok(matchesAuthorName('Ada Lovelace', 'Lovelace'), 'a subset of the parts is enough');
});

test('two different people do not match', () => {
  assert.equal(matchesAuthorName('Ada Lovelace', 'Grace Hopper'), false);
  assert.equal(matchesAuthorName('Ada Lovelace', ''), false);
  assert.equal(matchesAuthorName('', 'Ada Lovelace'), false);
  assert.equal(matchesAuthorName('Ada Lovelace', undefined), false);
});

test('SOURCE: the matcher lives here and openAlexService imports it', async () => {
  // PaperBuilder needs this matcher to graft OpenAlex ids onto the authors a
  // card already shows, and openAlexService already imports PaperBuilder — so
  // the matcher cannot stay in openAlexService without closing a cycle.
  const service = (await readFile(new URL('../services/openAlexService.js', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  // `assert.ok` rather than `doesNotMatch`: a failure here should name the
  // problem, not print the whole service.
  assert.ok(!/function\s+matchesAuthorName\b/.test(service), 'no second copy of the matcher');
  assert.ok(!/function\s+normalizeNameForMatch\b/.test(service), 'no second copy of its helper');
  assert.ok(/from\s+'\.\.\/utils\/authorNameMatch\.js'/.test(service), 'it imports the shared one');

  const builder = (await readFile(new URL('../services/PaperBuilder.js', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/openAlexService/.test(builder), 'the builder never reaches back into the service');
});
