import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInteractionAliasIndex, normalizedProviderId, paperIdentities, resolveInteractionId } from './interaction-aliases.ts';

test('provider ids that arrive in several shapes normalize to one', () => {
  assert.equal(normalizedProviderId('W2741809807'), 'openalex:W2741809807');
  assert.equal(normalizedProviderId('openalex:W2741809807'), 'openalex:W2741809807');
  assert.equal(normalizedProviderId('https://openalex.org/W2741809807'), 'openalex:W2741809807');
  assert.equal(normalizedProviderId('pmid:31234567'), 'pmid:31234567');
  assert.equal(normalizedProviderId('649def34f8be52c8b66281af98ae884c09aef38b'), '649def34f8be52c8b66281af98ae884c09aef38b', 'a hash is left alone');
  assert.equal(normalizedProviderId(''), '');
});

test('a paper answers to its id, its DOI and its arXiv id', () => {
  assert.deepEqual(paperIdentities({ id: 'W77', doi: 'https://doi.org/10.1103/PhysRevApplied.2.064003', arxivId: '1411.0000v2' }),
    ['openalex:W77', 'doi:10.1103/physrevapplied.2.064003', 'arxiv:1411.0000']);
  assert.deepEqual(paperIdentities({ id: '10.1000/abc' }), ['10.1000/abc', 'doi:10.1000/abc'], 'an id that is a DOI yields the DOI form too');
  assert.deepEqual(paperIdentities({ id: '2401.12345' }), ['2401.12345', 'arxiv:2401.12345']);
  assert.deepEqual(paperIdentities(null), []);
});

const index = buildInteractionAliasIndex([
  ['openalex:W77', { id: 'openalex:W77', doi: '10.1103/PhysRevApplied.2.064003', arxivId: '' }],
  ['arxiv:2401.12345', { id: '', arxivId: '2401.12345' }],
  ['649def34f8be52c8b66281af98ae884c09aef38b', { doi: '10.5555/s2paper' }],
  ['pmid:31234567', null],
]);

test('the alias table maps every identity a stored copy answers to onto its interaction id', () => {
  assert.equal(index.get('doi:10.1103/physrevapplied.2.064003'), 'openalex:W77');
  assert.equal(index.get('openalex:W77'), 'openalex:W77');
  assert.equal(index.get('arxiv:2401.12345'), 'arxiv:2401.12345');
  assert.equal(index.get('doi:10.5555/s2paper'), '649def34f8be52c8b66281af98ae884c09aef38b');
  assert.equal(index.get('pmid:31234567'), 'pmid:31234567', 'a record with no copy still answers to its own id');
});

test('a paper hydrated under another id resolves to the id its marks live under', () => {
  const byDoi = { id: 'W77', doi: 'https://doi.org/10.1103/physrevapplied.2.064003' };
  assert.equal(resolveInteractionId(byDoi, index), 'openalex:W77', 'the bare OpenAlex id from a DOI lookup');
  assert.equal(resolveInteractionId({ id: 'arxiv:9999.00001', doi: '10.5555/s2paper' }, index), '649def34f8be52c8b66281af98ae884c09aef38b',
    'the feed served it from arXiv; the like was made under the Semantic Scholar hash');
  assert.equal(resolveInteractionId({ id: '2401.12345' }, index), 'arxiv:2401.12345', 'the bare arXiv id meets the prefixed key');
  assert.equal(resolveInteractionId({ id: 'openalex:W1', doi: '10.1/never' }, index), 'openalex:W1', 'a paper never touched keeps its id');
  assert.equal(resolveInteractionId({ id: 'openalex:W2', doi: '10.1103/physrevapplied.2.064003' }, index, (id) => id === 'openalex:W2'), 'openalex:W2',
    'a mark already known under the paper\'s own id wins over an alias');
  assert.equal(resolveInteractionId({ id: '' }, index), '');
  assert.equal(resolveInteractionId(null, index), undefined);
});
