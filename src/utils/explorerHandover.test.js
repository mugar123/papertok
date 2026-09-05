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
  const institution = { id: 'https://openalex.org/I173304897', display_name: 'Harvard University', country_code: 'US', ror: 'https://ror.org/03vek6s52' };
  assert.deepEqual(handoverFromSearchRow('institution', institution), institution);
  assert.deepEqual(handoverFromSearchRow('topic', { id: 'https://openalex.org/T10001', display_name: 'Neuroscience', works_count: 12 }), { id: 'https://openalex.org/T10001', display_name: 'Neuroscience', works_count: 12 });
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
