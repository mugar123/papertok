import test from 'node:test';
import assert from 'node:assert/strict';
import { SemanticScholarAdapter } from './adapters/semantic-scholar-adapter.ts';
import { PaperBuilder } from './paper-builder.ts';
import { accessStatusForPaper } from '../utils/paper-status.ts';

// This adapter reached `api.semanticscholar.org` with a bare `fetch(url)` -- no
// key, no signal -- and a three-attempt backoff of its own, which every open tab
// ran independently against a limit Semantic Scholar counts per provider. The
// author pages that use it are public, so guests ran it too.

function silencedGlobalFetch(recorded: string[]) {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  globalThis.fetch = async input => {
    recorded.push(String((input as Request)?.url || input));
    return new Response('{}', { status: 500 });
  };
  console.error = () => {};
  return () => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  };
}

test('searches Semantic Scholar through the Worker route', async () => {
  const escaped: string[] = [];
  const workerCalls: (string|URL)[] = [];
  const restore = silencedGlobalFetch(escaped);
  try {
    const adapter = new SemanticScholarAdapter({
      apiBase: 'https://papertok-report-api.example',
      fetchImpl: async url => {
        workerCalls.push(String(url));
        return new Response(JSON.stringify({
          total: 7,
          data: [{ paperId: 'abc', title: 'One', authors: [], publicationTypes: [] }],
        }), { headers: { 'content-type': 'application/json' } });
      },
    });

    const result = await adapter.search('Ada Lovelace', 3, { type: 'author' });

    assert.equal(result.total, 7);
    assert.equal(result.papers.length, 1);
    const requested = new URL(workerCalls[0]);
    assert.equal(requested.pathname, '/sources/s2');
    assert.equal(requested.searchParams.get('q'), 'Ada Lovelace');
    assert.equal(requested.searchParams.get('page'), '3');
  } finally {
    restore();
  }

  assert.deepEqual(
    escaped.filter(url => url.includes('api.semanticscholar.org')),
    [],
    'Semantic Scholar was still called directly from the browser',
  );
});

test('gives up on an unavailable Semantic Scholar instead of retrying locally', async () => {
  const escaped: never[] = [];
  const restore = silencedGlobalFetch(escaped);
  let workerCalls = 0;
  try {
    const adapter = new SemanticScholarAdapter({
      apiBase: 'https://papertok-report-api.example',
      fetchImpl: async () => {
        workerCalls += 1;
        return new Response(JSON.stringify({ code: 'PROVIDER_RATE_LIMITED' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '60' },
        });
      },
    });

    const result = await adapter.search('Ada Lovelace', 1);

    assert.deepEqual(result, { papers: [], total: 0 });
    // One attempt, not three. The retry belongs behind the shared ceiling, where
    // there is one counter; here it only multiplied the pressure that caused the
    // refusal in the first place.
    assert.equal(workerCalls, 1);
  } finally {
    restore();
  }
});

/**
 * A paper saved from a Semantic Scholar card was remembered under its S2 hash
 * alone: the adapter wrote `doi: null` whatever the API said. The DOI and the
 * arXiv id arrive in `externalIds`, and they are the paper's only addresses.
 */
test('keeps the DOI and the arXiv id Semantic Scholar reports, and nothing invented when it reports none', () => {
  const adapter = new SemanticScholarAdapter();
  const addressed = adapter.mapToStandard({
    paperId: '649def34f8be52c8b66281af98ae884c09aef38b',
    title: 'Attention Is All You Need',
    externalIds: { DOI: '10.48550/arXiv.1706.03762', ArXiv: '1706.03762', CorpusId: 13756489 } as NonNullable<NonNullable<Parameters<typeof adapter.mapToStandard>[0]>["externalIds"]> & Record<string, unknown>,
  });
  assert.equal(addressed.id, '649def34f8be52c8b66281af98ae884c09aef38b', 'the S2 hash stays the id');
  assert.equal(addressed.doi, '10.48550/arXiv.1706.03762');
  assert.equal(addressed.arxivId, '1706.03762');

  const bare = adapter.mapToStandard({ paperId: 'abc', title: 'One', externalIds: { CorpusId: 1 } as NonNullable<NonNullable<Parameters<typeof adapter.mapToStandard>[0]>["externalIds"]> & Record<string, unknown> });
  assert.equal(bare.doi, null);
  assert.equal(bare.arxivId, undefined);
  const absent = adapter.mapToStandard({ paperId: 'abc', title: 'One' });
  assert.equal(absent.doi, null);
});

// Synthetic records (Semantic Scholar was not queried). The mapper wrote the
// current year for `year: null`, which sorted that work first under newest and
// let it through "Last year". A missing citation count read as a confirmed
// zero, and a missing open-access flag as a paywall.
test('a Semantic Scholar record that omits its year, citations and open-access flag stays unknown', () => {
  const adapter = new SemanticScholarAdapter();
  const [row] = PaperBuilder.deduplicate([
    adapter.mapToStandard({ paperId: 'a'.repeat(40), title: 'An undated work', year: null, citationCount: null }),
  ]);

  assert.equal(row.year, undefined);
  assert.equal(row.citationCountKnown, false);
  assert.equal(row.openAccess, undefined);
  assert.equal(accessStatusForPaper(row), null);
});

test('a Semantic Scholar record keeps the year, the zero and the open-access answer it reports', () => {
  const adapter = new SemanticScholarAdapter();
  const build = (isOpenAccess: boolean) => PaperBuilder.deduplicate([
    adapter.mapToStandard({ paperId: 'b'.repeat(40), title: 'A reported work', year: 2019, citationCount: 0, isOpenAccess }),
  ])[0];

  const closed = build(false);
  assert.equal(closed.year, 2019);
  assert.equal(closed.citationCount, 0);
  assert.equal(closed.citationCountKnown, true);
  // Semantic Scholar's own `false` is an answer, as OpenAlex's `is_oa: false` is.
  assert.equal(accessStatusForPaper(closed), 'subscription');
  assert.equal(accessStatusForPaper(build(true)), 'open');
});

test('strips boolean operators as words, not as letters inside words', async () => {
  const escaped: never[] = [];
  const restore = silencedGlobalFetch(escaped);
  let asked: string | null = '';
  try {
    const adapter = new SemanticScholarAdapter({
      apiBase: 'https://papertok-report-api.example',
      fetchImpl: async url => {
        asked = new URL(String(url)).searchParams.get('q');
        return new Response(JSON.stringify({ total: 0, data: [] }), { headers: { 'content-type': 'application/json' } });
      },
    });

    await adapter.search('CORD-19 NAND ANDROID OR bandwidth', 1);
  } finally {
    restore();
  }

  // `replace(/OR|AND/g, ' ')` turned CORD-19 into "C D-19" and ANDROID into
  // " ROID". Nobody saw it because the adapter is only reached with
  // `type: 'author'`, which skips the line -- until the day it is not.
  assert.match(asked, /^CORD-19 NAND ANDROID\s+bandwidth$/);
});
