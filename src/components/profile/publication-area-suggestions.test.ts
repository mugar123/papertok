import assert from 'node:assert/strict';
import test from 'node:test';
import { formatOpenAlexWorkAsPaper } from '../../utils/open-alex-work.ts';
import { arrangeOrcidWorks, readerPapers } from '../../services/orcid-service.ts';
import { publicationAreas, suggestedInterests } from './publication-area-suggestions.ts';
import { saveSelectedInterests } from '../settings/interests-save-refusal.ts';

// Synthetic OpenAlex works as returned by the existing profile lookups.
const topic = (id: string, field: number) => ({
  id: 'https://openalex.org/' + id, display_name: 'Topic', field: { id: 'https://openalex.org/fields/' + field, display_name: 'Field' },
});
const paper = (id: number, ...topics: ReturnType<typeof topic>[]) => formatOpenAlexWorkAsPaper({
  id: 'https://openalex.org/W' + id, primary_topic: topics[0], topics,
}, true);

test('only the current reader’s publications contribute new interests, including secondary topics', () => {
  const attributed = [paper(1, topic('T10036', 17), topic('T10948', 26)), paper(2, topic('T10818', 31)), paper(3, topic('T10025', 31))];
  const decisions = { mine: ['openalex:W1'], notMine: ['openalex:W2'] };
  const loaded = {
    decisions, totalWorks: 1, details: 'complete' as const, addedPapers: [], recordKeys: new Set(['openalex:W2']),
    publications: [{ paper: attributed[1], work: { title: null, year: null, doi: null, type: null, putCode: null, externalIds: [] } }],
    attributed: { papers: attributed, complete: true, total: 3, authorIds: [], failed: false },
  };
  const { publications } = arrangeOrcidWorks(loaded, decisions);
  assert.deepEqual(publicationAreas(readerPapers(publications, decisions), ['cs.CV']), ['math.CO']);
  const fresh = { mine: [], notMine: [] };
  assert.deepEqual(publicationAreas(readerPapers(arrangeOrcidWorks(loaded, fresh).publications, fresh), []), ['astro-ph.HE']);
});

test('unmapped and ambiguous topics fall back to a known field, while missing fields stay unknown', () => {
  assert.deepEqual(publicationAreas([paper(1, topic('T99999', 17), topic('T10320', 17), topic('T99998', 99))], []), ['cs']);
  assert.deepEqual(publicationAreas([paper(1, topic('T10025', 31)), paper(2)], []), ['hep-th']);
  assert.deepEqual(publicationAreas([paper(1, topic('T99999', 20))], ['econ.EM', 'econ.GN', 'econ.TH']), []);
});

test('the Settings save action receives existing interests and canonical leaves for a confirmed broad field', async () => {
  const existing = ['cs.CV', 'econ.EM'];
  const areas = publicationAreas([paper(1, topic('T99999', 20))], existing);
  const selected = new Set([...existing, ...suggestedInterests(areas)]);
  const writes: string[][] = [];
  assert.equal(await saveSelectedInterests(selected, async ids => { writes.push(ids); }), null);
  assert.deepEqual(writes, [['cs.CV', 'econ.EM', 'econ.GN', 'econ.TH']]);
});
