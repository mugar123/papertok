import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The search page's filter is a scope chosen inside the field: a ui Select
 * on desktop, a bottom drawer of rows on a phone, both bound to the active
 * filter. The page is a plain <main>; the results are one region.
 */

const jsxFile = readFile(new URL('./SearchPage.tsx', import.meta.url), 'utf8');

test('the field ends in the scope, a named Select on desktop and a drawer on a phone', async () => {
  const jsx = await jsxFile;
  const field = jsx.slice(jsx.indexOf('<div className={`search-input-wrapper'), jsx.indexOf('{/* Shown on the scopes'));
  assert.match(field, /<SearchScope value=\{activeSearchFilter\} onChange=\{handleSearchFilterChange\} \/>/);
  const scope = jsx.slice(jsx.indexOf('function SearchScope('), jsx.indexOf('export default function SearchPage'));
  assert.match(scope, /if \(isPhone\) \{[\s\S]*?<Drawer>[\s\S]*?aria-label=\{`Search in: \$\{current\.label\}`\}/);
  assert.match(scope, /<DrawerClose[\s\S]*?aria-current=\{id === value \? 'true' : undefined\}/, 'the current scope is marked in the drawer');
  assert.match(scope, /<SelectTrigger[^>]*aria-label=\{'Search in'\}/);
  assert.doesNotMatch(jsx, /<Tabs\b|<TabsList|<TabsTrigger|<TabsContent/, 'no tab widget is left without its tabs');
});

test('the search field is the ui Input with a name, and follow is the detail pages\' FollowToggle', async () => {
  const jsx = await jsxFile;
  assert.match(jsx, /<Input\s+type="search"\s+className="search-input"[\s\S]*?aria-label=\{'Search PaperTok'\}/);
  assert.match(jsx, /<FollowToggle\s+pressed=\{following\}/);
  assert.doesNotMatch(jsx, /aria-pressed=/);
});
