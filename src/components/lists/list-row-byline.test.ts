import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../../models/paper.ts';
import { paperLegacyAdapter } from '../../models/paper.ts';
import { buildSavedPaperPayload } from '../../utils/saved-paper-payload.ts';
import { bylineText } from './list-row-byline.ts';

const names = (count: number) => Array.from({ length: count }, (_, index) => `Author ${index + 1}`);
const namesOf = (paper: Partial<Paper>) => (paper.authors ?? []).map(author => (typeof author === 'string' ? author : author.name));

// A savedPapers document kept five names, and the row counted them: a paper
// with ten authors read "+2".
test('a byline counts the authors a saved document keeps', () => {
  const card = { id: '2505.06123', title: 'A paper with ten authors', authors: names(10).map(name => ({ name })) };
  const saved = paperLegacyAdapter({ id: card.id, ...JSON.parse(JSON.stringify(buildSavedPaperPayload(card, '2026-11-12T10:00:00.000Z'))) });
  assert.deepEqual(bylineText(namesOf(saved)), { names: 'Author 1, Author 2, Author 3', more: ' +7' });
});

test('a byline cut at a stored cap reads et al., not a count', () => {
  assert.equal(bylineText(names(5)).more, ' et al.', 'the five a savedPapers document kept');
  assert.equal(bylineText(names(20)).more, ' et al.', 'the twenty an interaction\'s copy keeps');
  assert.equal(bylineText(names(4)).more, ' +1');
  assert.equal(bylineText(names(3)).more, null);
});

// INSPIRE and ADS name authors "Last, First": three people read as six.
test('a byline of names with commas separates them with semicolons', () => {
  assert.deepEqual(
    bylineText(['Bonizzoni, Claudio', 'Lamberto, Daniele', 'Napoli, Samuel', 'Ghirri, Alberto']),
    { names: 'Bonizzoni, Claudio; Lamberto, Daniele; Napoli, Samuel', more: ' +1' },
  );
  assert.equal(bylineText(['Claudio Bonizzoni', 'Daniele Lamberto']).names, 'Claudio Bonizzoni, Daniele Lamberto');
});
