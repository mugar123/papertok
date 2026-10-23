import assert from 'node:assert/strict';
import test from 'node:test';
import { encodePaperKey, parsePaperKey } from '../utils/publicNavigation.ts';
import { openAlexClient } from './openAlexClient.ts';
import { loadPaperByIdentity } from './paperLookup.ts';

// PAP-88: the public paper page opens a DOI as one OpenAlex work, which is
// free and never refused by the Worker's budget. It used to ask for a works
// list filtered by DOI: billed, refused once the day passes the enrichment
// share, and a provider failure there read as "not found".

// Synthetic, shaped like an OpenAlex work.
const WORK = {
  id: 'https://openalex.org/W2741809807',
  doi: 'https://doi.org/10.7717/peerj.4375',
  title: 'The state of OA',
  publication_date: '2018-02-13',
  authorships: [{ author: { id: 'https://openalex.org/A1', display_name: 'Heather Piwowar' }, institutions: [] }],
  abstract_inverted_index: { Open: [0], access: [1] },
  primary_location: { landing_page_url: 'https://peerj.com/articles/4375', source: { display_name: 'PeerJ', type: 'journal' } },
  concepts: [],
};

const doiKey = (doi: string) => parsePaperKey(encodePaperKey('doi', doi)!)!;

test('a paper opened by DOI is one request for the work by DOI: found, not found, or a failure the page can retry', async t => {
  const realFetch = openAlexClient.fetchImpl;
  const realBase = openAlexClient.apiBase;
  t.after(() => {
    openAlexClient.fetchImpl = realFetch;
    openAlexClient.apiBase = realBase;
  });
  openAlexClient.apiBase = 'https://api.papertok.app';
  const urls: URL[] = [];
  const answering = (response: () => Response) => {
    urls.length = 0;
    openAlexClient.clearMemoryCache();
    openAlexClient.fetchImpl = async input => {
      urls.push(new URL(String(input)));
      return response();
    };
  };

  answering(() => Response.json(WORK));
  const paper = await loadPaperByIdentity(doiKey('10.7717/peerj.4375'));
  assert.deepEqual(urls.map(url => `${url.origin}${url.pathname}`), ['https://api.papertok.app/openalex/works/doi:10.7717/peerj.4375']);
  assert.equal(urls[0].searchParams.has('filter'), false);
  assert.equal(paper?.title, 'The state of OA');
  assert.equal(paper?.doi, '10.7717/peerj.4375');

  answering(() => Response.json({ error: 'Not found' }, { status: 404 }));
  assert.equal(await loadPaperByIdentity(doiKey('10.1000/missing')), null);
  assert.equal(urls.length, 1);

  answering(() => Response.json({ error: 'Service unavailable' }, { status: 503 }));
  await assert.rejects(loadPaperByIdentity(doiKey('10.1000/down')), (error: { status?: number }) => error.status === 503);
  assert.equal(urls.length, 1, 'asked once');
});
