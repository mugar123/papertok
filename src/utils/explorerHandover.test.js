import test from 'node:test';
import assert from 'node:assert/strict';
import { handedEntityFor, handoverFromSearchRow } from './explorerHandover.js';

/**
 * The palette's rows hold the entity they point at, and `go()` already hands a
 * paper over in router state. Measured before this: an author picked from the
 * palette arrived as a skeleton and collapsed 113px (156px on a phone, while
 * the page was still sliding in).
 */
test('an author row hands over what the hero paints', () => {
  const row = { id: 'https://openalex.org/A5068353058', display_name: 'David Moher', works_count: 1554, cited_by_count: 893080, h_index: 218, orcid: 'https://orcid.org/0000-0003-2434-4206', institution: "St. Michael's Hospital", concepts: [{ display_name: 'Medicine' }] };
  assert.deepEqual(handoverFromSearchRow('author', row), {
    id: 'https://openalex.org/A5068353058',
    display_name: 'David Moher',
    works_count: 1554,
    cited_by_count: 893080,
    summary_stats: { h_index: 218 },
    orcid: 'https://orcid.org/0000-0003-2434-4206',
    x_concepts: [{ display_name: 'Medicine' }],
    institution: "St. Michael's Hospital",
  });
});

test('an institution row is handed over as it is; a topic row keeps its name and count', () => {
  const institution = { id: 'https://openalex.org/I173304897', display_name: 'Harvard University', country_code: 'US', ror: 'https://ror.org/03vek6s52', works_count: 187432, cited_by_count: 9876543, summary_stats: { h_index: 412 } };
  assert.deepEqual(handoverFromSearchRow('institution', institution), institution);
  assert.deepEqual(handoverFromSearchRow('topic', { id: 'https://openalex.org/T10001', display_name: 'Neuroscience', works_count: 12 }), { id: 'https://openalex.org/T10001', display_name: 'Neuroscience', works_count: 12 });
});

/**
 * `searchLocalTopics` (openAlexService.js) sets `_localTopic: true` on every
 * row it produces and returns local topics before remote ones, so this is
 * the common case, not the edge case. Its `id` is a CATEGORIES key, so
 * `handedEntityFor` would accept the handover — and `EntityExplorer` resolves
 * `handedEntity || localTopic`, so a stripped handover would win over the
 * richer entity the page already resolves for itself from CATEGORIES.
 */
test('a local topic row hands nothing over; the page already resolves it better from CATEGORIES', () => {
  const localTopic = {
    id: 'health',
    display_name: 'Salud y Medicina',
    labelEs: 'Salud y Medicina',
    labelEn: 'Health & Medicine',
    description: 'Investigación biomédica, salud pública y clínica.',
    level: 0,
    categoryIds: ['health.oncology', 'health.neuroscience'],
    works_count: null,
    _localTopic: true,
  };
  assert.equal(handoverFromSearchRow('topic', localTopic), null);
});

/**
 * `rankInstitutionsByProminence` (openAlexService.js) returns ROR candidates
 * unenriched on two expected paths — a single candidate, or the prominence
 * fetch failing or coming back empty — so a handed institution can carry no
 * counts at all. `explorerReservation.test.js` pins
 * `.ehc-stats-grid:empty { display: none; }`, so a countless hero reserves a
 * zero-height stats grid that then grows when the fetch lands.
 */
test('an institution row without counts hands nothing over; the page reserves what it cannot paint yet', () => {
  const bare = { id: 'https://openalex.org/I173304897', display_name: 'Harvard University', country_code: 'US', ror: 'https://ror.org/03vek6s52', works_count: null, cited_by_count: null, summary_stats: null };
  assert.equal(handoverFromSearchRow('institution', bare), null);
  assert.equal(handoverFromSearchRow('institution', { ...bare, works_count: 187432 }), null, 'cited_by_count is still missing');
  assert.equal(handoverFromSearchRow('institution', { ...bare, cited_by_count: 9876543 }), null, 'works_count is still missing');
});

test('a row without a name, or a type the page cannot paint, hands nothing over', () => {
  assert.equal(handoverFromSearchRow('author', { id: 'A1' }), null);
  assert.equal(handoverFromSearchRow('project', { id: 'FW04020064', display_name: 'X' }), null);
  assert.equal(handoverFromSearchRow('author', null), null);
});

test('a route accepts the handed entity only when it names it', () => {
  const entity = { id: 'https://openalex.org/A5068353058', display_name: 'David Moher', orcid: 'https://orcid.org/0000-0003-2434-4206' };
  const state = { entity, entityType: 'author' };
  assert.equal(handedEntityFor('author', 'A5068353058', state), entity);
  assert.equal(handedEntityFor('author', 'https%3A%2F%2Forcid.org%2F0000-0003-2434-4206', state), entity, 'an ORCID route matches on the orcid');
  assert.equal(handedEntityFor('author', 'A999', state), null, 'another author is not this one');
  assert.equal(handedEntityFor('institution', 'A5068353058', state), null, 'another type is not this one');
  assert.equal(handedEntityFor('author', 'A5068353058', null), null);
  assert.equal(handedEntityFor('author', 'A5068353058', { entity: null, entityType: 'author' }), null);
});

test('institutions and topics match on the last path segment', () => {
  const institution = { id: 'https://openalex.org/I173304897', display_name: 'Harvard University' };
  assert.equal(handedEntityFor('institution', 'I173304897', { entity: institution, entityType: 'institution' }), institution);
  const topic = { id: 'https://openalex.org/T10001', display_name: 'Neuroscience' };
  assert.equal(handedEntityFor('topic', 'T10001', { entity: topic, entityType: 'topic' }), topic);
  assert.equal(handedEntityFor('topic', 'T10002', { entity: topic, entityType: 'topic' }), null);
});
