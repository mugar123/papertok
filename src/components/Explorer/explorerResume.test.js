import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * SOURCE tests for the two halves of institution <-> author, measured
 * 2026-09-18 on the production build with a signed-in profile
 * (docs/AUDITORIA-EXPLORER-IDA-Y-VUELTA-2026-09-18.md).
 *
 * The way back: the route is keyed by pathname, so stepping back mounts the
 * institution afresh — on Papers when it was left on Authors, with a hero
 * 171px short of what it had been because the Wikipedia block was being
 * asked for again, and that height arriving as a settle once the reveal had
 * finished. A visit memory seeds the next mount with what the last one had,
 * and the effects that would clear or refetch it stand down exactly once.
 */
test('an entity page comes back as it was left: tab, authors, Wikipedia block and impact figure', async () => {
  const jsx = stripComments(await read('./EntityExplorer.jsx'));
  assert.match(jsx, /const visitMemory = new Map\(\);/);
  assert.match(jsx, /const resumed = useMemo\(\(\) => visitMemory\.get\(visitKey\) \|\| null, \[visitKey\]\);/);
  for (const seed of [
    /useState\(\(\) => resumed\?\.wikiInfo \?\? null\)/,
    /useState\(\(\) => resumed\?\.settledWikiRequestKey \?\? ''\)/,
    /useState\(\(\) => resumed\?\.recentImpact \?\? null\)/,
    /useState\(\(\) => resumed\?\.activeTab \?\? 'papers'\)/,
    /useState\(\(\) => Boolean\(resumed\?\.authorsOpened\)\)/,
    /useState\(\(\) => \(resumed && !resumed\.authorsSearch \? resumed\.entityAuthors : \[\]\)\)/,
  ]) assert.match(jsx, seed);
  // The load effect keeps the seeded pieces on the mount that resumed, and only then.
  assert.match(jsx, /const resuming = resumedEntityRef\.current;\s*resumedEntityRef\.current = false;\s*if \(!resuming\) \{\s*setEntityAuthors\(\[\]\);\s*setWikiInfo\(null\);\s*setWikiBlockOpened\(false\);\s*\}/);
  assert.match(jsx, /if \(!resuming\) setRecentImpact\(null\);/);
  // The authors effect neither refetches nor shows its skeleton over a resumed list.
  assert.match(jsx, /if \(resumedAuthorsRef\.current\) \{\s*resumedAuthorsRef\.current = false;\s*return;\s*\}/);
  // The deferred tab reset is for an entity change, never for the mount.
  assert.match(jsx, /if \(resetForEntityRef\.current === visitKey\) return undefined;/);
  // And every seeded piece is written back as it changes.
  assert.match(jsx, /rememberVisit\(visitKey, \{\s*activeTab,\s*authorsOpened,\s*authorsSearch: debouncedSearch,\s*entityAuthors,\s*authorsPage,\s*hasMoreAuthors,\s*wikiInfo,\s*settledWikiRequestKey,\s*loadedWikiImageUrl,\s*isWikiDescriptionExpandable,\s*wikiDescriptionExpandedHeight,\s*isWikiDescriptionExpanded,\s*recentImpact,\s*\}\);/);
  // The read-more toggle is a measurement taken a frame after mount: seeded, or the block comes back 27px short for that frame.
  assert.match(jsx, /useState\(\(\) => Boolean\(resumed\?\.isWikiDescriptionExpandable\)\)/);
  assert.match(jsx, /useState\(\(\) => resumed\?\.wikiDescriptionExpandedHeight \?\? 0\)/);
  assert.match(jsx, /if \(!resuming\) \{\s*setIsWikiDescriptionExpanded\(false\);\s*setIsWikiDescriptionExpandable\(false\);\s*\}/);
  assert.match(jsx, /if \(visitMemory\.size > VISIT_MEMORY_MAX\)/);
});

/**
 * The way in: an author opened from an institution's Authors tab arrived as
 * a skeleton — the card held the author's name and counts and handed over
 * none of it — its name landing at 600ms and its hero settling twice. The
 * card hands its row over the way a palette row does, and the page is born
 * with it (`handedEntityFor`).
 */
test('an author card hands its row over, so the author page is born with a name and counts', async () => {
  const jsx = stripComments(await read('./EntityExplorer.jsx'));
  assert.match(jsx, /import \{ handedEntityFor, handoverFromSearchRow \} from '\.\.\/\.\.\/utils\/explorerHandover\.js';/);
  assert.match(jsx, /const navigateToEntity = useCallback\(\(nextType, nextId, handover = null\) => \{/);
  assert.match(jsx, /const entityForNext = handover \? handoverFromSearchRow\(nextType, handover\) : null;/);
  assert.match(jsx, /entityForNext \? \{ state: \{ entity: entityForNext, entityType: nextType \} \} : undefined/);
  assert.match(jsx, /onClick=\{\(\) => navigateToEntity\('author', author\.id, author\)\}/);
  assert.match(jsx, /handleActivationKey\(event, \(\) => navigateToEntity\('author', author\.id, author\)\)/);
});

/**
 * And the other entrance: an author already in cache had its thirty paper
 * rows mount inside the frames the page was still travelling on — no frame
 * from 147 to 325ms. The first page of rows waits out the arrival, like the
 * Wikipedia block does (`useAfterPageArrival`).
 */
test('the first page of papers waits out the page\'s arrival before it mounts', async () => {
  const jsx = stripComments(await read('./EntityExplorer.jsx'));
  assert.match(jsx, /if \(page === 1\) \{\s*const arriving = afterPageArrival\(\);\s*if \(arriving\) await arriving;\s*if \(request\.cancelled\) return;\s*setPapers\(fetchedPapers\);\s*\}/);
  assert.match(jsx, /\}, \[afterPageArrival, type, id, entity, entityDisplayName, sortBy, page, debouncedSearch, filters, searchParams, papersReloadKey, entityReloadKey\]\);/);
});
