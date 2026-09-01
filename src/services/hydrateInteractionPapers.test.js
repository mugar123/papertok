import test from 'node:test';
import assert from 'node:assert/strict';
import { hydrateInteractionPapers } from './hydrateInteractionPapers.js';

test('hydrates arXiv, OpenAlex and DOI ids back onto the interaction key', async () => {
  const fetched = await hydrateInteractionPapers(
    ['hep-th/0603001', 'openalex:W2269592689', 'doi:10.1000/example', 'ads:2021JHEP...03..014J'],
    {
      fetchArxivByIds: async (ids) => {
        assert.deepEqual(ids, ['hep-th/0603001']);
        return [{ id: 'hep-th/0603001', arxivId: 'hep-th/0603001', title: 'Quantum gravity note' }];
      },
      fetchOpenAlexByIds: async (ids) => {
        assert.deepEqual(ids, ['W2269592689']);
        return [{ id: 'W2269592689', title: 'A real OpenAlex title' }];
      },
      fetchDois: async (ids) => {
        assert.deepEqual(ids, ['10.1000/example']);
        return [{ id: '10.1000/example', doi: '10.1000/example', title: 'A DOI paper' }];
      },
    },
  );

  assert.equal(fetched.get('hep-th/0603001').title, 'Quantum gravity note');
  assert.equal(fetched.get('openalex:W2269592689').title, 'A real OpenAlex title');
  assert.equal(fetched.get('doi:10.1000/example').title, 'A DOI paper');
  assert.equal(fetched.has('ads:2021JHEP...03..014J'), false, 'ADS bibcodes have no provider here');
});

test('drops provider answers that are still identity-shaped', async () => {
  const fetched = await hydrateInteractionPapers(['1807.10247'], {
    fetchArxivByIds: async () => [{ id: '1807.10247', title: '1807.10247' }],
    fetchOpenAlexByIds: async () => [],
    fetchDois: async () => [],
  });
  assert.equal(fetched.size, 0);
});

test('a provider failure does not strand the other ids', async () => {
  const fetched = await hydrateInteractionPapers(
    ['hep-th/0603001', 'openalex:W1'],
    {
      fetchArxivByIds: async () => { throw new Error('arxiv down'); },
      fetchOpenAlexByIds: async () => [{ id: 'W1', title: 'Survived' }],
      fetchDois: async () => [],
    },
  );
  assert.equal(fetched.get('openalex:W1').title, 'Survived');
  assert.equal(fetched.has('hep-th/0603001'), false);
});

test('fetchLibraryRecordsHydrated fills ids Firestore omitted', async () => {
  const { fetchLibraryRecordsHydrated } = await import('./hydrateInteractionPapers.js');
  const result = await fetchLibraryRecordsHydrated(
    'uid',
    ['openalex:W1', 'hep-th/0603001'],
    {
      readRecords: async () => ({
        records: [{ id: 'openalex:W1', data: { paperTitle: 'Stored title' } }],
        fromCache: false,
      }),
      hydrate: async (ids) => {
        assert.deepEqual(ids, ['hep-th/0603001']);
        return new Map([['hep-th/0603001', { id: 'hep-th/0603001', title: 'Quantum gravity note' }]]);
      },
    },
  );
  assert.equal(result.records.length, 2);
  assert.equal(result.records.find(row => row.id === 'hep-th/0603001').data.paperTitle, 'Quantum gravity note');
  assert.equal(result.records.find(row => row.id === 'openalex:W1').data.paperTitle, 'Stored title');
  assert.equal(result.authoritative, true);
});

test('fetchLibraryRecordsHydrated replaces placeholder titles on stored records', async () => {
  const { fetchLibraryRecordsHydrated } = await import('./hydrateInteractionPapers.js');
  const result = await fetchLibraryRecordsHydrated(
    'uid',
    ['openalex:W1'],
    {
      readRecords: async () => ({
        records: [{ id: 'openalex:W1', data: { paperTitle: 'openalex:W1' } }],
        fromCache: false,
      }),
      hydrate: async (ids) => {
        assert.deepEqual(ids, ['openalex:W1']);
        return new Map([['openalex:W1', { id: 'openalex:W1', title: 'A real title' }]]);
      },
    },
  );
  assert.equal(result.records[0].data.paperTitle, 'A real title');
});

test('unfilled slash ids are not a server-confirmed absence', async () => {
  const { fetchLibraryRecordsHydrated } = await import('./hydrateInteractionPapers.js');
  const result = await fetchLibraryRecordsHydrated(
    'uid',
    ['hep-th/0603001'],
    {
      readRecords: async () => ({ records: [], fromCache: false }),
      hydrate: async () => new Map(),
    },
  );
  assert.equal(result.records.length, 0);
  assert.equal(result.authoritative, false);
});
