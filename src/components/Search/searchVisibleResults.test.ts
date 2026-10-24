import test from 'node:test';
import assert from 'node:assert/strict';
import type { SearchScope } from '../../services/entitySearchService.ts';
import { visibleSearchResults } from './searchVisibleResults.ts';

const SCOPES: SearchScope[] = ['all', 'papers', 'authors', 'institutions', 'topics', 'projects'];
const none = { papers: 0, authors: 0, institutions: 0, topics: 0, projects: 0 };

// A bare, valid ORCID that matches nothing else renders the Direct ORCID card
// under All and Authors. The live region once announced "No results found"
// beside it under All.
test('a direct ORCID hit is counted wherever its card is shown', () => {
  const orcidOnly = { ...none, cleanOrcid: '0000-0002-1825-0097' };
  assert.deepEqual(visibleSearchResults({ ...orcidOnly, scope: 'all' }), { hasResults: true, hasVisibleResults: true, visibleResultCount: 1 });
  assert.deepEqual(visibleSearchResults({ ...orcidOnly, scope: 'authors' }), { hasResults: true, hasVisibleResults: true, visibleResultCount: 1 });
  assert.deepEqual(visibleSearchResults({ ...orcidOnly, scope: 'papers' }), { hasResults: true, hasVisibleResults: false, visibleResultCount: 0 });
});

test('the count and the painted results agree in every scope', () => {
  const inputs = [
    { ...none, cleanOrcid: null },
    { ...none, cleanOrcid: '0000-0002-1825-0097' },
    { papers: 3, authors: 0, institutions: 1, topics: 0, projects: 2, cleanOrcid: null },
    { papers: 0, authors: 2, institutions: 0, topics: 4, projects: 0, cleanOrcid: '0000-0002-1825-0097' },
  ];
  for (const input of inputs) {
    for (const scope of SCOPES) {
      const { hasVisibleResults, visibleResultCount } = visibleSearchResults({ ...input, scope });
      assert.equal(hasVisibleResults, visibleResultCount > 0, `${scope}: ${JSON.stringify(input)}`);
    }
  }
});

test('each scope counts its own section', () => {
  const found = { papers: 3, authors: 2, institutions: 1, topics: 4, projects: 5, cleanOrcid: '0000-0002-1825-0097' };
  assert.deepEqual(
    SCOPES.map(scope => visibleSearchResults({ ...found, scope }).visibleResultCount),
    [16, 3, 3, 1, 4, 5],
  );
});
