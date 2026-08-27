import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpenAlexTopicFilters,
  extractFeaturedConcepts,
  formatOpenAlexWork,
  getArxivCategoriesForReport,
  getDateThresholds,
  getPubmedCategoriesForReport,
  lendCitationsToArxivCandidates,
  paperMatchesCategory,
  scorePaper,
} from './scientificReportService.js';

test('uses inclusive calendar-day ranges without adding an extra day', () => {
  const now = new Date(2026, 6, 16, 12, 0, 0);

  assert.deepEqual(getDateThresholds('24h', now), {
    fromStr: '2026-07-15',
    toStr: '2026-07-16',
    days: 2,
  });
  assert.deepEqual(getDateThresholds('7d', now), {
    fromStr: '2026-07-10',
    toStr: '2026-07-16',
    days: 7,
  });
  assert.deepEqual(getDateThresholds('30d', now), {
    fromStr: '2026-06-17',
    toStr: '2026-07-16',
    days: 30,
  });
});

test('counts both endpoints of a custom report range', () => {
  assert.equal(getDateThresholds({
    type: 'custom',
    from: '2026-07-10',
    to: '2026-07-16',
  }).days, 7);
});

test('preserves the OpenAlex publication date used by report ranking', () => {
  const paper = formatOpenAlexWork({
    id: 'https://openalex.org/W1',
    title: '<i>Recent discovery</i>',
    publication_date: '2024-05-17',
    cited_by_count: 12,
    authorships: [],
    concepts: [],
    open_access: { is_oa: true },
  });

  assert.equal(paper.title, 'Recent discovery');
  assert.equal(paper.published, '2024-05-17');
  assert.equal(paper.year, 2024);
});

test('age-normalized report ranking rewards a genuinely recent paper', () => {
  const now = new Date('2026-07-16T12:00:00Z');
  const rankingState = () => [new Map(), 3650, new Map(), now];
  const recent = { citationCount: 100, published: '2026-01-16', abstract: 'A'.repeat(200), categories: ['physics'] };
  const old = { ...recent, published: '2017-01-16' };

  assert.ok(
    scorePaper(recent, '10y', ...rankingState()) > scorePaper(old, '10y', ...rankingState()),
  );
});

test('extracts featured topics from string and OpenAlex object concepts', () => {
  const concepts = extractFeaturedConcepts([
    { concepts: [{ display_name: 'Quantum computing', score: 0.9, level: 2 }, { display_name: 'Physics', score: 0.6, level: 0 }] },
    { concepts: ['Quantum computing', 'Machine Learning'] },
    { categories: ['cs.AI'] },
  ]);

  assert.equal(concepts[0], 'Quantum computing');
  assert.ok(concepts.includes('Machine Learning'));
  assert.ok(concepts.includes('Inteligencia Artificial'));
  assert.ok(!concepts.includes('Physics'));
});

test('groups OpenAlex fields by selected discipline instead of querying every field', () => {
  assert.deepEqual(buildOpenAlexTopicFilters(['med']), [
    'primary_topic.field.id:24|27|28|29|30|35|36',
  ]);
  assert.deepEqual(buildOpenAlexTopicFilters(['civil', 'mech']), [
    'primary_topic.field.id:22',
  ]);
});

test('expands broad report disciplines for arXiv and PubMed', () => {
  const physics = getArxivCategoriesForReport(['physics']);
  assert.ok(physics.includes('quant-ph'));
  assert.ok(physics.includes('astro-ph.CO'));
  assert.ok(physics.length > 10);

  const biomedical = getPubmedCategoriesForReport(['bio', 'med']);
  assert.ok(biomedical.includes('bio.gen'));
  assert.ok(biomedical.includes('med.cardio'));
});

test('does not treat a shared OpenAlex field as proof of a narrower discipline', () => {
  const electricalPaper = {
    primaryTopic: { field: { id: 'https://openalex.org/fields/22' } },
    categories: ['Electrical engineering'],
  };
  const civilPaper = {
    primaryTopic: { field: { id: 'https://openalex.org/fields/22' } },
    categories: ['Structural Engineering'],
  };

  assert.equal(paperMatchesCategory(electricalPaper, 'civil'), false);
  assert.equal(paperMatchesCategory(civilPaper, 'civil'), true);
});


/* ── Borrowing citations for the arXiv candidates ──
   arXiv publishes no citation counts, so its papers reached a citation-weighted
   selection with a zero and never survived it — and arXiv is the only source a
   figure can be extracted from, so the pictures went with them. */

function arxivPaper(arxivId, extra = {}) {
  return { id: arxivId, arxivId, title: `Paper ${arxivId}`, ...extra };
}

test('an arXiv paper with no citations is given the count OpenAlex knows', async () => {
  const candidates = [arxivPaper('2501.00001')];
  const result = await lendCitationsToArxivCandidates(
    candidates,
    async () => ({ '2501.00001': { citationCount: 42 } }),
  );

  assert.equal(result[0].citationCount, 42);
  assert.equal(result[0].citationCountKnown, true);
  // The candidates handed in are left alone: they are about to be cached.
  assert.equal(candidates[0].citationCount, undefined);
});

test('a paper that already has citations is not overwritten', async () => {
  const [paper] = await lendCitationsToArxivCandidates(
    [arxivPaper('2501.00002', { citationCount: 7 })],
    async () => ({ '2501.00002': { citationCount: 999 } }),
  );
  assert.equal(paper.citationCount, 7);
});

test('a paper with no arXiv id is never looked up', async () => {
  let asked = null;
  const candidates = [{ id: 'openalex-1', title: 'From OpenAlex', citationCount: 3 }];
  const result = await lendCitationsToArxivCandidates(candidates, async (ids) => { asked = ids; return {}; });
  assert.equal(asked, null);
  assert.equal(result, candidates);
});

test('the identifier is normalized before it is asked for', async () => {
  let asked = null;
  await lendCitationsToArxivCandidates(
    [arxivPaper('arxiv:2501.00003v4')],
    async (ids) => { asked = ids; return {}; },
  );
  assert.deepEqual(asked, ['2501.00003']);
});

test('two copies of one paper both receive the count', async () => {
  const result = await lendCitationsToArxivCandidates(
    [arxivPaper('2501.00004'), arxivPaper('2501.00004v2', { id: 'other' })],
    async () => ({ '2501.00004': { citationCount: 11 } }),
  );
  assert.deepEqual(result.map(paper => paper.citationCount), [11, 11]);
});

test('a lookup that fails leaves the edition exactly as it was', async () => {
  const candidates = [arxivPaper('2501.00005')];
  const result = await lendCitationsToArxivCandidates(candidates, async () => {
    throw new Error('OpenAlex is down');
  });
  assert.equal(result, candidates);
  assert.equal(result[0].citationCount, undefined);
});

test('a lookup that answers with nothing useful changes nothing', async () => {
  const candidates = [arxivPaper('2501.00006')];
  for (const answer of [{}, { '2501.00006': {} }, { '2501.00006': { citationCount: 0 } }]) {
    const result = await lendCitationsToArxivCandidates(candidates, async () => answer);
    assert.equal(result, candidates, `answer ${JSON.stringify(answer)} should be a no-op`);
  }
});

test('only the papers that were missing a count are rebuilt', async () => {
  const known = arxivPaper('2501.00007', { citationCount: 5 });
  const plain = { id: 'plain', title: 'No arXiv id' };
  const needy = arxivPaper('2501.00008');
  const result = await lendCitationsToArxivCandidates(
    [known, plain, needy],
    async () => ({ '2501.00008': { citationCount: 20 } }),
  );

  // Untouched papers keep their identity, so nothing downstream re-renders for
  // a paper whose data did not change.
  assert.equal(result[0], known);
  assert.equal(result[1], plain);
  assert.notEqual(result[2], needy);
  assert.equal(result[2].citationCount, 20);
});
