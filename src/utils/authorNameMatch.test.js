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

// PubMed writes "Surname INITIALS". The old matcher never split "WN" and
// did not anchor the surname, so "Li WN" matched "Po-Wn Li" (1 work) and not
// "Wan-Ning Li" (the author of PMID 42774036), and "Chen YC" matched
// "Y. C. Pan" (audit 2026-09-23, issue 4).
test('a PubMed "Surname INITIALS" name matches by surname and initials, in order', () => {
  assert.equal(matchesAuthorName('Li WN', 'Wan-Ning Li'), true);
  assert.equal(matchesAuthorName('Li WN', 'W. N. Li'), true);
  assert.equal(matchesAuthorName('Li WN', 'WN Li'), true);
  assert.equal(matchesAuthorName('Li WN', 'Po-Wn Li'), false);
  assert.equal(matchesAuthorName('Li WN', 'Lin Li-Wn'), false);
  assert.equal(matchesAuthorName('Chen YC', 'Y. C. Pan'), false);
  assert.equal(matchesAuthorName('Pidugu VK', 'Vijaya Kumar Pidugu'), true);
  assert.equal(matchesAuthorName('Smith J', 'John Smith'), true);
  assert.equal(matchesAuthorName('Smith J', 'Mary Smith'), false);
});

test('the surname is the anchor: the same given name on another surname is another person', () => {
  assert.equal(matchesAuthorName('Wei Zhang', 'Wei Chen'), false);
  assert.equal(matchesAuthorName('Ada Lovelace', 'Ada Byron'), false);
  assert.equal(matchesAuthorName('Wei Zhang', 'Yong-Wei Zhang'), false);
});

test('a "Surname, Given" name and a two-word name in either order are the same person', () => {
  assert.equal(matchesAuthorName('Nicolás Cuello', 'Cuello, N.'), true);
  assert.equal(matchesAuthorName('Wei Zhang', 'Zhang Wei'), true);
  assert.equal(matchesAuthorName('W. Zhang', 'Zhang Wei'), true);
  assert.equal(matchesAuthorName('Lei Ke', 'Ke Lei'), true);
});

// A Spanish or Portuguese name carries two surnames and is often indexed with
// one, and a first initial is often dropped in front of the name a person goes
// by. This matcher lost both, where the one before it matched them, so the
// fast author link and the name search both refused these (review of
// 2026-09-25).
test('a double surname and a leading initial written on one side only still match', () => {
  assert.equal(matchesAuthorName('Nicolás Muñoz García', 'Nicolás Muñoz'), true);
  assert.equal(matchesAuthorName('Gabriel García Márquez', 'Gabriel García'), true);
  assert.equal(matchesAuthorName('Ana Pérez Gómez', 'Ana Pérez'), true);
  assert.equal(matchesAuthorName('J. Robert Oppenheimer', 'Robert Oppenheimer'), true);
  assert.equal(matchesAuthorName('S. Mohammad Hosseini', 'Mohammad Hosseini'), true);
});

test('the double-surname and initial readings do not let another person through', () => {
  assert.equal(matchesAuthorName('Juan Carlos Pérez', 'Carlos Pérez'), false);
  assert.equal(matchesAuthorName('Ana Pérez Gómez', 'Luis Pérez'), false);
  assert.equal(matchesAuthorName('Nicolás Muñoz García', 'Pedro Muñoz'), false);
  assert.equal(matchesAuthorName('J. Robert Oppenheimer', 'Frank Oppenheimer'), false);
  assert.equal(matchesAuthorName('A. M. Gavrilik', 'B. Gavrilik'), false);
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
