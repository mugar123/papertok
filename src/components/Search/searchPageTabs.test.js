import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The search page's filter bar is a ui Tabs (line variant): Base UI wires
 * `aria-controls` / `aria-labelledby` between pills and panel and gives the
 * pills arrow keys, so none of that is written by hand any more; the active
 * pill is marked by the indicator's yellow rule, the one mark the yellow is
 * for (design.md, rule 3).
 */

const jsxFile = readFile(new URL('./SearchPage.jsx', import.meta.url), 'utf8');
const cssFile = readFile(new URL('./SearchPage.css', import.meta.url), 'utf8');

test('the filter bar is a Tabs root with a line list, and the results are its panel', async () => {
  const jsx = await jsxFile;
  const css = await cssFile;
  assert.match(jsx, /<Tabs\s+className="search-page-container"\s+value=\{activeSearchFilter\}\s+onValueChange=\{handleSearchFilterChange\}/);
  assert.match(jsx, /<TabsList\s+variant="line"\s+className="search-filter-bar"\s+aria-label=\{isEnglish \? 'Filter search results' : 'Filtrar resultados de búsqueda'\}/);
  assert.match(jsx, /<TabsTrigger[\s\S]*?value=\{id\}\s+className="search-filter-pill"/);
  assert.match(jsx, /<TabsContent\s+value=\{activeSearchFilter\}\s+id="search-results-panel"/);
  assert.doesNotMatch(jsx, /role="tab"|role="tablist"|aria-selected=/, 'Base UI writes the tab roles and states');
  assert.match(css, /\.search-filter-pill\[data-active\]/);
  assert.doesNotMatch(css, /\.search-filter-pill\.active/);
  assert.match(css, /\.search-filter-bar \[data-slot='tabs-indicator'\]/, 'the yellow rule sits inside the scroll box');
});

test('the search field is the ui Input with a name, and follow is a Toggle', async () => {
  const jsx = await jsxFile;
  assert.match(jsx, /<Input\s+type="search"\s+className="search-input"[\s\S]*?aria-label=\{isEnglish \? 'Search PaperTok' : 'Buscar en PaperTok'\}/);
  assert.match(jsx, /<Toggle\s+variant="outline"\s+className=\{`search-follow-btn[\s\S]*?pressed=\{following\}/);
  assert.doesNotMatch(jsx, /aria-pressed=/);
});
