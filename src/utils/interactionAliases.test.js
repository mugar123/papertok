import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInteractionAliasIndex, normalizedProviderId, paperIdentities, resolveInteractionId } from './interactionAliases.js';

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

import { readFile } from 'node:fs/promises';
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/**
 * SOURCE: the table is built from the library the context already loads,
 * every mark is written under the resolved id, and every surface that shows
 * a mark looks it up under the resolved id too.
 */
test('SOURCE: the context builds the alias table and writes every mark under the resolved id', async () => {
  const code = stripComments(await read('../context/FeedContext.jsx'));
  assert.match(code, /const interactionAliasIndex = useMemo\(\(\) => buildInteractionAliasIndex\(\[\s*\.\.\.Object\.entries\(libraryPapers\),\s*\.\.\.Object\.entries\(personalLibrary\)/,
    'from the stored copies, no new read');
  for (const name of ['toggleLike', 'markNotInterested', 'markAsRead', 'toggleReadLater']) {
    assert.match(code, new RegExp(`const ${name} = useCallback\\(async \\(paperInput\\) => \\{\\s*const paper = withInteractionId\\(paperInput\\);`), name);
  }
  assert.match(code, /const saveReadingMetadata = useCallback\(async \(paperInput, \{ note = '', tags = \[\] \}\) => \{\s*const paper = withInteractionId\(paperInput\);/);
  assert.match(code, /const markSaved = useCallback\(async \(paperOrIdInput\) => \{\s*const paperOrId = paperOrIdInput && typeof paperOrIdInput === 'object' \? withInteractionId\(paperOrIdInput\) : paperOrIdInput;/);
  assert.match(code, /interactionIdFor, libraryCopyFor,\s*feedMode, setFeedMode/, 'both are handed to the surfaces');
});

test('SOURCE: a direct link is answered with the reader\'s own copy when the library holds one', async () => {
  const code = stripComments(await read('../components/Public/PublicPaperPage.jsx'));
  assert.match(code, /if \(!loadedPaper \|\| seededPaper\) return loadedPaper;\s*const copy = libraryCopyFor\(loadedPaper\);\s*if \(copy\) return hydrateSeededPaper\(paperLegacyAdapter\(\{ \.\.\.copy\.paper, id: copy\.id \}\), loadedPaper\);/,
    'the copy is laid over the provider\'s answer exactly as a list\'s copy is');
  assert.match(code, /const id = interactionIdFor\(loadedPaper\);\s*return id === loadedPaper\.id \? loadedPaper : \{ \.\.\.loadedPaper, id \};/,
    'with no copy, the id alone is resolved');
  assert.match(code, /if \(isAuthenticated\) void ensurePersonalLibrary\?\.\(\);/, 'the library is asked for, since a link opens no list first');
});

test('SOURCE: every card surface looks a mark up under the resolved id', async () => {
  for (const [path, subject] of [
    ['../components/Feed/FeedContainer.jsx', 'paper'],
    ['../components/Search/SearchPage.jsx', 'selectedPaper'],
    ['../components/Explorer/EntityExplorer.jsx', 'selectedPaper'],
    ['../components/Report/ScientificReport.jsx', 'selectedPaper'],
    ['../components/Lists/ListsPage.jsx', 'overlayPaper'],
  ]) {
    const code = stripComments(await read(path));
    assert.doesNotMatch(code, new RegExp(`PaperIds\\??\\.has\\(${subject}\\.id\\)`), `${path} still reads a mark by the raw id`);
    assert.match(code, new RegExp(`readPaperIds\\??\\.has\\(interactionIdFor\\(${subject}\\)\\)`), path);
  }
});
