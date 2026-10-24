import test from 'node:test';
import assert from 'node:assert/strict';
import { PubmedAdapter } from './adapters/PubmedAdapter.ts';
import { classifyPubmedCategory } from './adapters/pubmedRecords.ts';
import { accessTagForPaper } from '../utils/paperStatus.ts';

test('classifies PubMed papers using title, abstract, and MeSH-style subjects', () => {
  const category = classifyPubmedCategory({
    title: 'Cardiac arrhythmia after myocardial infarction',
    abstract: 'A clinical study of cardiovascular outcomes.',
    categories: ['Heart Diseases', 'Cardiology'],
  }, ['med.onco', 'med.cardio', 'med.neuro']);

  assert.equal(category, 'med.cardio');
});

test('does not invent a random PubMed category for ambiguous papers', () => {
  const category = classifyPubmedCategory({
    title: 'A multicenter observational study',
    abstract: 'Results from several participating institutions.',
    categories: [],
  }, ['med.onco', 'med.cardio']);

  assert.equal(category, null);
});

// Searching one subcategory used to file every record under it, whatever the
// record said; one subcategory needs the same evidence as several.
test('files a record searched for one subcategory under it only on evidence', () => {
  assert.equal(classifyPubmedCategory({ title: 'Sparse metadata record' }, ['bio.micro']), null);
  assert.equal(classifyPubmedCategory({ title: 'Gut microbiome of aged mice' }, ['bio.micro']), 'bio.micro');
});

// Synthetic esummary records. Searched for one subcategory, every record used
// to be filed under it; a record now needs the evidence several require.
test('a PubMed search for one subcategory keeps only the records that name it', async () => {
  const adapter = new PubmedAdapter({
    apiBase: 'https://papertok-report-api.example',
    fetchImpl: async () => Response.json({
      esearchresult: { count: '2', idlist: ['31000011', '31000012'] },
      result: {
        31000011: { uid: '31000011', title: 'Histological analysis of Ewing sarcoma', pubtype: ['Journal Article'] },
        31000012: { uid: '31000012', title: 'Molecular biology of the replication fork', pubtype: ['Journal Article'] },
      },
      efetch: '',
    }),
  });

  const { papers } = await adapter.search('"Molecular Biology" one subcategory', 1, { internalCategories: ['bio.mol'] });

  assert.deepEqual(papers.map(paper => [paper.id, paper.primaryCategory]), [['pmid:31000012', 'bio.mol']]);
  assert.deepEqual(papers.map(paper => paper._fetchedFor), [['bio.mol']]);
});

test('a PMC copy makes a PubMed paper open, through the canonical openAccess field', () => {
  const adapter = new PubmedAdapter();
  const pmcPaper = adapter.mapToStandard({
    uid: '2',
    title: 'Open',
    articleids: [{ idtype: 'pmc', value: 'PMC2' }],
  });

  assert.equal(pmcPaper.openAccess, true);
  assert.equal((pmcPaper as typeof pmcPaper & { isOpenAccess?: never }).isOpenAccess, undefined);
});

test('a PubMed record with no PMC copy yet says nothing about access', () => {
  // PMID 42773801 as esummary served it on 2026-09-23, a day after it came out:
  // CC BY in Annals of Medicine, fully open, and not deposited in PMC yet. The
  // deposit takes days to months, so "no PMC" is not a paywall, and the card
  // used to tag this paper "Suscripción".
  const record = {
    uid: '42773801',
    pubdate: '2026 Dec',
    epubdate: '2026 Sep 22',
    source: 'Ann Med',
    title: 'An Annals of Medicine article',
    pubtype: ['Journal Article'],
    articleids: [
      { idtype: 'pubmed', idtypen: 1, value: '42773801' },
      { idtype: 'doi', idtypen: 3, value: '10.1080/07853890.2026.2726635' },
    ],
  };
  const paper = new PubmedAdapter().mapToStandard(record);

  assert.equal(paper.openAccess, undefined);
  assert.equal(accessTagForPaper(paper), null);
});

// The three E-utilities requests this adapter used to make left the browser
// directly, with no abort signal and no NCBI key, so readers behind one NAT
// rate-limited each other. They now go to the Worker as one call. Nothing below
// asserts the mapping -- that is unchanged on purpose -- only where the bytes
// come from.

function recordingGlobalFetch(recorded: unknown[]) {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const originalError = console.error;
  globalThis.fetch = async input => {
    recorded.push(String((input as Request)?.url || input));
    return new Response('{}', { status: 500 });
  };
  console.warn = () => {};
  console.error = () => {};
  return () => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    console.error = originalError;
  };
}

test('reads PubMed through the Worker route instead of calling NCBI from the browser', async () => {
  const escaped: string[] = [];
  const workerCalls: (string|URL)[] = [];
  const restore = recordingGlobalFetch(escaped);
  try {
    const adapter = new PubmedAdapter({
      apiBase: 'https://papertok-report-api.example',
      fetchImpl: async url => {
        workerCalls.push(String(url));
        return new Response(JSON.stringify({
          esearchresult: { count: '2', idlist: ['31000001'] },
          result: { 31000001: { uid: '31000001', title: 'One', articleids: [] } },
          // Deliberately empty: parsing it needs `DOMParser`, which is a browser
          // API, and the enrichment it feeds is optional by design.
          efetch: '',
          _papertok: { efetch: 'unavailable' },
        }), { headers: { 'content-type': 'application/json' } });
      },
    });

    const result = await adapter.search('malaria', 2, { type: 'author' });

    assert.equal(result.total, 2);
    assert.equal(result.papers[0].id, 'pmid:31000001');
    assert.equal(workerCalls.length, 1);
    const requested = new URL(workerCalls[0]);
    assert.equal(requested.pathname, '/sources/pubmed');
    assert.equal(requested.searchParams.get('q'), 'malaria[Author]');
    assert.equal(requested.searchParams.get('page'), '2');
    assert.equal(requested.searchParams.get('limit'), '25');
  } finally {
    restore();
  }

  const toNcbi = escaped.filter(url => url.includes('eutils.ncbi.nlm.nih.gov'));
  assert.deepEqual(toNcbi, [], `PubMed was still called directly: ${toNcbi.join(', ')}`);
  assert.deepEqual(escaped, [], `PubMed search still issued extra browser fetches: ${escaped.join(', ')}`);
});

test('a feed search asks PubMed only for records with an abstract', async () => {
  const queries: string[] = [];
  const adapter = new PubmedAdapter({
    apiBase: 'https://papertok-report-api.example',
    fetchImpl: async url => {
      queries.push(new URL(String(url)).searchParams.get('q')!);
      return new Response(JSON.stringify({ esearchresult: { count: '0', idlist: [] } }), { headers: { 'content-type': 'application/json' } });
    },
  });

  await adapter.search('"Oncology" OR "Cardiology"', 1, { requireAbstract: true });
  await adapter.search('"Oncology" OR "Cardiology"', 1);

  assert.deepEqual(queries, ['("Oncology" OR "Cardiology") AND hasabstract', '"Oncology" OR "Cardiology"']);
});

test('carries a deadline on the PubMed request', async () => {
  const escaped: string[] = [];
  const restore = recordingGlobalFetch(escaped);
  let seenSignal;
  try {
    const adapter = new PubmedAdapter({
      apiBase: 'https://papertok-report-api.example',
      fetchImpl: async (_url, options) => {
        seenSignal = options?.signal;
        return new Response(JSON.stringify({ esearchresult: { count: '0', idlist: [] } }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await adapter.search('malaria', 1);
  } finally {
    restore();
  }

  assert.ok(seenSignal, 'the PubMed request reaches the Worker with no AbortSignal');
  assert.equal((seenSignal as AbortSignal).aborted, false);
});
