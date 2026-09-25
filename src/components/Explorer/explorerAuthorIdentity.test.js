import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// An author page opened by a name alone used to show whoever the name search
// returned first, append works found by the same name in three more sources,
// and offer to follow that person: "Li WN" opened "Po-Wn Li", "Wei Zhang" one
// profile of many (audit 2026-09-23, issue 4). The rules live in
// utils/entityExplorer.js (`authorIdentityVerified`, `sourceArxivIdFrom`) and
// openAlexService (`getAuthorProfileExact`); the Explorer cannot mount under
// Node, so this pins that it goes through them.
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const jsx = stripComments(readFileSync(new URL('./EntityExplorer.jsx', import.meta.url), 'utf8'));

test('a name-only author is resolved with the paper the link carries', () => {
  assert.match(jsx, /data = await getAuthorProfileExact\(id, searchParams\.get\('paper'\) \|\| searchParams\.get\('arxivId'\)\);/);
});

// An ORCID OpenAlex has not linked to anyone fell straight to a stub whose
// list is an arXiv search by name. The paper the link came from can still say
// which author entity wrote it, so it is asked before the stub (review of
// 2026-09-25).
test('an ORCID OpenAlex does not know is resolved with the paper before falling back to a stub', () => {
  const branch = jsx.slice(jsx.indexOf('if (orcidId) {'), jsx.indexOf('if (orcidId) {') + 1200);
  assert.match(
    branch,
    /prefetchedOrcid = await getOrcidRecord\(orcidId\);\s*const sourceReference = searchParams\.get\('paper'\) \|\| searchParams\.get\('arxivId'\);\s*if \(prefetchedOrcid\?\.displayName && sourceReference\) \{\s*const fromPaper = await getAuthorProfileExact\(prefetchedOrcid\.displayName, sourceReference\);\s*if \(fromPaper\?\.verified\) data = fromPaper;\s*\}\s*if \(!data && prefetchedOrcid\?\.displayName\) \{\s*data = \{\s*id: `stub-\$\{orcidId\}`,/,
  );
});

test('an unverified author gets no Follow and a notice that the results come from the name', () => {
  assert.match(jsx, /const authorIdentityUnverified = Boolean\(entity\) && !authorIdentityVerified\(\{ type, routeId: id, entity \}\);/);
  const follow = jsx.slice(jsx.indexOf('const followEntity = useMemo(() => {'), jsx.indexOf('const followEntity = useMemo(() => {') + 300);
  assert.match(follow, /if \(!entity \|\| authorIdentityUnverified \|\|/);
  assert.match(
    jsx,
    /\{authorIdentityUnverified \? \(\s*<p className="ehc-identity-note">\s*\{isEnglish\s*\? 'Found by name: these results may mix people who share it\.'\s*: 'Encontrado por el nombre: los resultados pueden mezclar a personas que se llaman igual\.'\}\s*<\/p>\s*\) : followEntity && \(/,
  );
});

test('only an unverified author page adds works found by the name in other sources', () => {
  const block = jsx.slice(jsx.indexOf("} else if (type === 'author') {"), jsx.indexOf("} else if (type === 'author') {") + 1400);
  assert.match(block, /const nameOnly = !authorIdentityVerified\(\{ type, routeId: id, entity \}\);/);
  assert.match(block, /const supplementalPromises = nameOnly\s*\? \[/);
  assert.match(block, /: \[Promise\.resolve\(\{ papers: \[\] \}\), Promise\.resolve\(\{ papers: \[\] \}\), Promise\.resolve\(\{ papers: \[\] \}\)\];/);
});

test('the source paper is fetched from arXiv only when the link carried an arXiv id', () => {
  assert.match(jsx, /const sourceArxivId = sourceArxivIdFrom\(searchParams\.get\('arxivId'\)\);/);
  assert.doesNotMatch(jsx, /const cleanSourceId = sourceArxivId\.replace/);
});
