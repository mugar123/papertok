/**
 * Live check for the paper search coverage: the three searches that used to
 * miss papers that exist upstream, run against the real providers through the
 * PaperTok Worker, exactly as `paperSearchService.js` composes them.
 *
 *   node scripts/diagnostics/search-coverage-check.mjs
 *
 * Consumes quota: three OpenAlex calls on the Worker's daily budget plus three
 * paced arXiv calls, and one more OpenAlex call per case with the OLD filter
 * to show the difference (`--no-before` skips those). Not part of `npm test`;
 * the offline pin is `src/services/paperSearchService.test.js`.
 *
 * Env: PAPER_API_BASE (default https://api.papertok.app), ORIGIN (an allowed
 * origin; default https://papertok.app). Exit code 1 when a case fails.
 */

import { XMLParser } from 'fast-xml-parser';
import { OPENALEX_SEARCH_TYPES, OpenAlexAdapter } from '../../src/services/adapters/OpenAlexAdapter.js';
import { identifyOpenAlexUrl } from '../../src/services/openAlexClient.js';
import { PaperBuilder } from '../../src/services/PaperBuilder.js';
import { rankPaperSearchResults } from '../../src/utils/searchRelevance.js';

const API_BASE = (process.env.PAPER_API_BASE || 'https://api.papertok.app').replace(/\/$/, '');
const ORIGIN = process.env.ORIGIN || 'https://papertok.app';
const SHOW_BEFORE = !process.argv.includes('--no-before');
// The filter the adapter shipped until 2026-09-22. OpenAlex retired the type
// name, so this list is what "before" means here.
const RETIRED_TYPES = ['article', 'proceedings-article'];

const CASES = [
  {
    query: 'FC-CLIP',
    expect: { arxivId: '2308.02487' },
    label: 'the FC-CLIP paper (arXiv 2308.02487) is in the ten',
  },
  {
    query: 'Convolutions Die Hard: Open-Vocabulary Segmentation with Single Frozen Convolutional CLIP',
    expect: { arxivId: '2308.02487', position: 1 },
    label: 'the near-exact title is the first result',
  },
  {
    query: 'segment anything',
    expect: { title: 'Segment Anything', position: 1 },
    label: 'the original "Segment Anything" (ICCV 2023) is the first result',
  },
  {
    query: 'llama 2',
    expect: { arxivId: '2307.09288', position: 1 },
    label: 'the Llama 2 paper (arXiv 2307.09288) is the first result',
  },
];

const adapter = new OpenAlexAdapter();
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

async function fetchText(url) {
  const response = await fetch(url, { headers: { origin: ORIGIN } });
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return response.text();
}

async function searchOpenAlex(query, types) {
  const url = identifyOpenAlexUrl(adapter.buildSearchUrl(query, 1, { types }), 'app@papertok.io', API_BASE);
  const data = JSON.parse(await fetchText(url));
  if (!Array.isArray(data.results)) throw new Error(`OpenAlex: ${JSON.stringify(data).slice(0, 200)}`);
  return data.results.map(work => adapter.mapToStandard(work)).filter(Boolean);
}

// The same request `arxivService.searchPapers` sends, read with a parser Node
// has (the app parses with DOMParser).
async function searchArxiv(query) {
  const params = new URLSearchParams({
    search_query: `all:"${query.replace(/"/g, '')}"`,
    start: '0',
    max_results: '10',
    sortBy: 'relevance',
  });
  const feed = xml.parse(await fetchText(`${API_BASE}/arxiv?${params}`));
  const entries = [].concat(feed?.feed?.entry || []);
  const text = value => (typeof value === 'object' && value !== null ? value['#text'] : value) || '';
  return entries.map((entry) => {
    const arxivId = String(text(entry.id)).replace(/.*\/abs\//, '').replace(/v\d+$/, '');
    return PaperBuilder.create({
      id: arxivId,
      arxivId,
      sources: { primary: 'arxiv', enrichedBy: [] },
      title: String(text(entry.title)).replace(/\s+/g, ' ').trim(),
      abstract: String(text(entry.summary)).replace(/\s+/g, ' ').trim(),
      authors: [].concat(entry.author || []).map(author => ({ name: text(author.name) })),
      doi: text(entry['arxiv:doi']),
      year: Number(String(text(entry.published)).slice(0, 4)) || undefined,
      publicationType: 'preprint',
      publicationStatus: 'preprint',
      openAccess: true,
      landingPageUrl: `https://arxiv.org/abs/${arxivId}`,
    });
  });
}

const describe = paper => `${paper.arxivId ? `arXiv:${paper.arxivId}` : paper.doi || paper.id} | ${paper.title}`;

function matches(paper, expect) {
  if (expect.arxivId) return paper.arxivId === expect.arxivId;
  return String(paper.title || '').trim().toLowerCase() === expect.title.toLowerCase();
}

let failures = 0;
for (const testCase of CASES) {
  console.log(`\n=== "${testCase.query}"`);
  const [openAlex, arxiv, before] = await Promise.all([
    searchOpenAlex(testCase.query, OPENALEX_SEARCH_TYPES).catch(error => { console.warn('  OpenAlex failed:', error.message); return []; }),
    searchArxiv(testCase.query).catch(error => { console.warn('  arXiv failed:', error.message); return []; }),
    SHOW_BEFORE ? searchOpenAlex(testCase.query, RETIRED_TYPES).catch(() => null) : Promise.resolve(null),
  ]);

  if (before) {
    const found = before.findIndex(paper => matches(paper, testCase.expect));
    console.log(`  before (OpenAlex only, type:${RETIRED_TYPES.join('|')}): ${before.length} results, expected paper ${found === -1 ? 'ABSENT' : `at #${found + 1}`}`);
  }

  const ranked = rankPaperSearchResults(testCase.query, PaperBuilder.deduplicate([...openAlex, ...arxiv])).slice(0, 10);
  const position = ranked.findIndex(paper => matches(paper, testCase.expect)) + 1;
  console.log(`  after  (OpenAlex ${openAlex.length} + arXiv ${arxiv.length}, merged and ranked):`);
  ranked.slice(0, 5).forEach((paper, index) => console.log(`   ${index + 1}. ${describe(paper)}`));

  const ok = position > 0 && (!testCase.expect.position || position <= testCase.expect.position);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${testCase.label}${position ? ` (found at #${position})` : ' (not in the ten)'}`);
}

console.log(failures ? `\n${failures} case(s) failed` : '\nAll cases pass');
process.exit(failures ? 1 : 0);
