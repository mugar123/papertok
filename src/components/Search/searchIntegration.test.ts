/**
 * The combined search box, pinned where it can actually break.
 *
 * There are two boxes: the full page (`SearchPage.tsx`) and the command
 * palette, which is a pair — `SearchCommand.tsx` paints and
 * `useEntitySearch.js` queries. The rules belong to the search, not to the
 * file that happened to implement it first, so the shared ones below run
 * against both surfaces.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/** A file minus its comments, so a comment mentioning a name is not evidence. */
async function readCode(relativePath: string|URL) {
  const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
}

const page = await readCode('./SearchPage.tsx');
const palette = await readCode('./SearchCommand.tsx');
const paletteSearch = await readCode('../../hooks/useEntitySearch.ts');
const paletteSources = await readCode('../../services/entitySearchService.ts');

// The palette is checked as one body of code: the component owns what is
// painted and the hook owns what is queried, and every rule here is about the
// pair.
const SURFACES = [
  { name: 'the search page', code: page },
  { name: 'the command palette', code: `${palette}\n${paletteSearch}\n${paletteSources}` },
];

test('the search never announces itself as unavailable', () => {
  // The page saying "the search is temporarily unavailable" is the page
  // denying its own existence — and it said it while results sat underneath.
  // A notice names the provider that went down, or it does not appear.
  for (const surface of SURFACES) {
    assert.doesNotMatch(surface.code, /Search is temporarily unavailable/, surface.name);
    assert.doesNotMatch(surface.code, /La búsqueda no está disponible/, surface.name);
  }
});

test('both surfaces report analytics only after their search settles', () => {
  assert.match(page, /await Promise\.all\(tasks\)/);
  assert.match(paletteSources, /await Promise\.all\(SEARCH_SECTIONS\.map/);
  assert.ok(paletteSearch.indexOf('await searchEntities(') < paletteSearch.indexOf("trackEvent('search_performed'"));
  assert.match(paletteSearch, /if \(controller\.signal\.aborted\) return;/);
});

test('the palette hides stale queries while providers collect independent sections', () => {
  assert.match(page, /hasVisibleResults && !searchPending/);
  assert.match(paletteSearch, /answer\?\.term === query\.trim\(\)/);
  assert.match(paletteSources, /if \(!signal\.aborted\) onUpdate\(snapshot\)/);
  assert.match(paletteSources, /pending: snapshot\.pending\.filter/);
});

test('both surfaces build their section values in one place', () => {
  // They were written out twice and had already drifted: the palette left
  // `aliases` and `acronyms` off its institutions, so it alone could not match
  // the "USAL" or "MIT" that ROR had handed it — and an acronym carries no
  // organisation word, so the exact sweep is the only way such a search lands.
  // A ranking that depends on which file you opened is not a ranking.
  for (const surface of SURFACES) {
    assert.match(surface.code, /buildSearchSectionValues\(/, surface.name);
    assert.doesNotMatch(surface.code, /sectionValues: \{/, `${surface.name}: no second copy`);
  }
});

test('both surfaces drop the institutions OpenAlex files as authors', () => {
  // `authors?search=university of salamanca` answers with four records whose
  // display_name IS "University of Salamanca" — no ORCID, no institution, a
  // handful of works. They score a flat 100, which took the top of the Authors
  // section and, with it, first place on the whole page from the real
  // university. A section that only one surface cleans is a bug with a
  // fifty-fifty chance of being seen.
  for (const surface of SURFACES) {
    assert.match(surface.code, /isOrganisationAuthorRecord/, surface.name);
    assert.match(
      surface.code,
      /getWeight: authorProminenceWeight/,
      `${surface.name}: and ranks what is left by prominence`,
    );
  }
});

/**
 * Reduced motion must not mean no content.
 *
 * A row that starts at `opacity: 0` and only reaches 1 through an animation is
 * invisible the moment that animation does not run, and `forwards`/`both` then
 * pins it there. The trap is written up in `design.md`, it has already shipped
 * once in this very stylesheet (the comment in the reduced-motion block of
 * `SearchPage.css` is the post-mortem), and every new entrance animation is
 * another chance to reintroduce it — silently, for exactly the users who asked
 * not to be shown motion.
 *
 * So the rule is mechanical: declare `opacity: 0` next to an `animation` and
 * you owe the same selector an `opacity: 1` under
 * `@media (prefers-reduced-motion: reduce)`.
 */
function withoutComments(css: string) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Innermost `selector { body }` pairs; at-rule wrappers fall out on their own. */
function innermostRules(css: string) {
  const rules = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = pattern.exec(css)) !== null) {
    rules.push({ selectors: match[1].trim().split(',').map(one => one.trim()).filter(Boolean), body: match[2] });
  }
  return rules;
}

/** The body of every `prefers-reduced-motion: reduce` block, brace-balanced. */
function reducedMotionBlocks(css: string) {
  const blocks = [];
  const opener = /@media \(prefers-reduced-motion: reduce\)\s*\{/g;
  let match;
  while ((match = opener.exec(css)) !== null) {
    const start = match.index + match[0].length;
    let depth = 1;
    let cursor = start;
    while (cursor < css.length && depth > 0) {
      if (css[cursor] === '{') depth += 1;
      else if (css[cursor] === '}') depth -= 1;
      cursor += 1;
    }
    blocks.push(css.slice(start, cursor - 1));
  }
  return blocks;
}

// Neither stylesheet hides content behind an entrance today (the page has no
// entrance animations; the palette's hold their first frame through the fill,
// pinned by paletteMotion.test.ts). One added later is still checked.
for (const [stylesheet, hidesStatically] of [['./SearchPage.css', false], ['./SearchCommand.css', false]] as const) {
  test(`${stylesheet.replace('./', '')} keeps its content visible without motion`, async () => {
    const css = withoutComments(await readFile(new URL(stylesheet, import.meta.url), 'utf8'));

    const restored = new Set();
    for (const block of reducedMotionBlocks(css)) {
      for (const rule of innermostRules(block)) {
        if (/opacity:\s*1\b/.test(rule.body)) rule.selectors.forEach(one => restored.add(one));
      }
    }

    const atRisk = innermostRules(css)
      .filter(rule => /opacity:\s*0\s*;/.test(rule.body) && /animation:/.test(rule.body))
      .flatMap(rule => rule.selectors);

    if (hidesStatically) assert.ok(atRisk.length > 0, 'expected to have found the animated entrances at all');
    for (const selector of atRisk) {
      assert.ok(
        restored.has(selector),
        `${selector} starts at opacity 0 and is only revealed by its animation, `
        + 'so it needs an opacity: 1 under prefers-reduced-motion or it is invisible there',
      );
    }
  });
}

test('an exit is animated, and an animated exit holds its last frame', async () => {
  // Base UI keeps a closing popup mounted for as long as
  // `element.getAnimations()` reports something running on it, then unmounts.
  // A CSS `animation` on `[data-closed]` is that something; without one the
  // node is gone on the spot and the exit is cut off at its first frame —
  // which reads as "the animation is too fast" rather than as a bug, and is
  // why `design.md` has a paragraph about it. (A `transition` on
  // `[data-ending-style]` would also be seen, but this stylesheet drives the
  // sheet and the scrim with keyframes, so the closed state owes an
  // `animation`.) `both` comes with it, to hold the last frame instead of
  // snapping back to full opacity on the way out.
  const css = withoutComments(
    await readFile(new URL('./SearchCommand.css', import.meta.url), 'utf8'),
  );
  const closing = innermostRules(css)
    .filter(rule => rule.selectors.some(one => one.includes('[data-closed]')));

  assert.ok(closing.length > 0, 'expected to have found the exit at all');
  for (const rule of closing) {
    // The reduced-motion block turns the animation off on purpose; that one is
    // allowed to say `none`, and an immediate unmount is then correct.
    if (/animation:\s*none/.test(rule.body)) continue;
    assert.match(rule.body, /animation:/, `${rule.selectors.join(', ')} must animate its exit`);
    assert.match(rule.body, /\bboth\b/, `${rule.selectors.join(', ')} should hold its last frame`);
  }
});

/**
 * `visibleResultCount` exists only so the hidden live region announcing a
 * search's outcome can never disagree with what `hasVisibleResults` decides
 * to paint. The one place that guarantee depends on more than a matching
 * `.length` is a direct ORCID hit: `hasVisibleResults` counts it under "all"
 * (through `hasResults`, defined two lines above the ternary) and under
 * "authors" (`|| !!cleanOrcid`), nowhere else. `visibleResultCount`'s "all"
 * branch once forgot its own `(cleanOrcid ? 1 : 0)` — search a bare, valid
 * ORCID that matches nothing else with "All" selected, and the Direct ORCID
 * card would render while the live region announced "no results found" for
 * that exact search. This walks every branch both ternaries share, in the
 * same fixed order, and asserts they agree about which ones count an ORCID
 * hit at all.
 */
test('visibleResultCount agrees with hasVisibleResults about a direct ORCID hit, branch by branch', () => {
  const hasVisibleBlock = page.match(
    /const hasVisibleResults = activeSearchFilter === 'all'[\s\S]*?conceptResults\.length > 0;/,
  )?.[0];
  assert.ok(hasVisibleBlock, 'could not find the hasVisibleResults ternary to check -- update this test alongside it');

  const countBlock = page.match(
    /const visibleResultCount = activeSearchFilter === 'all'[\s\S]*?conceptResults\.length;/,
  )?.[0];
  assert.ok(countBlock, 'could not find the visibleResultCount ternary to check -- update this test alongside it');

  /** The single-line value of one `? ...` branch, found by the filter name that guards it. */
  function branch(block: string, filterName: string) {
    const match = block.match(new RegExp(`activeSearchFilter === '${filterName}'\\s*\\n\\s*\\?\\s*([^\\n]+)`));
    return match ? match[1].trim() : null;
  }

  // "all": hasVisibleResults reads through `hasResults` (defined just above
  // the ternary) rather than naming cleanOrcid inline, so that indirection is
  // resolved by hand instead of by the generic loop below.
  assert.equal(
    branch(hasVisibleBlock, 'all'),
    'hasResults',
    'hasVisibleResults\' "all" branch changed shape; update this test alongside it',
  );
  assert.match(
    page,
    /const hasResults = hasSearchSectionResults \|\| !!cleanOrcid;/,
    'hasResults no longer folds in a direct ORCID hit -- "all" would silently stop counting one',
  );
  const countAllBranch = countBlock.match(
    /activeSearchFilter === 'all'\s*\n\s*\?\s*([\s\S]*?)\n\s*: activeSearchFilter === 'papers'/,
  )?.[1];
  assert.ok(countAllBranch, 'visibleResultCount\'s "all" branch changed shape; update this test alongside it');
  assert.match(
    countAllBranch,
    /\(cleanOrcid \? 1 : 0\)/,
    'visibleResultCount\'s "all" branch no longer adds a direct ORCID hit to the total. Search a bare, valid '
    + 'ORCID that matches nothing else with "All" selected: the Direct ORCID card renders (hasVisibleResults '
    + 'counts it there, through hasResults), but the hidden live region would announce "no results found" for '
    + 'that same search -- exactly the contradiction this variable exists to make impossible.',
  );

  // Every other branch, generically: whichever of the two counts an ORCID
  // hit here, the other must too, whatever that answer is. Only "authors"
  // is expected to answer "yes" today; the rest exist to prove the two stay
  // symmetric even where neither currently mentions cleanOrcid at all.
  for (const filterName of ['papers', 'institutions', 'authors', 'projects']) {
    const hasVisibleBranch = branch(hasVisibleBlock, filterName);
    const countBranch = branch(countBlock, filterName);
    assert.ok(hasVisibleBranch, `hasVisibleResults' "${filterName}" branch changed shape; update this test alongside it`);
    assert.ok(countBranch, `visibleResultCount's "${filterName}" branch changed shape; update this test alongside it`);

    const hasVisibleCounts = /cleanOrcid/.test(hasVisibleBranch);
    const countCounts = /cleanOrcid/.test(countBranch);
    assert.equal(
      countCounts,
      hasVisibleCounts,
      `"${filterName}": hasVisibleResults ${hasVisibleCounts ? 'counts' : 'does not count'} a direct ORCID hit `
      + `here, but visibleResultCount ${countCounts ? 'counts' : 'does not'} -- search a bare, valid ORCID that `
      + 'matches nothing else under this filter and the card and the live region would disagree about whether '
      + 'anything was found for the same search.',
    );
  }

  // The final, un-guarded "else" (topics) is implied by both block anchors
  // above already requiring the literal text `conceptResults.length[ > 0];`
  // as their closing branch -- a fixed expression with no room for
  // cleanOrcid in either ternary, so there is nothing further to compare.
});

/**
 * Every destination a search result offers has to be a route the app declares.
 *
 * This is the rule the palette broke: papers were pointed at
 * `/explorer/paper/<id>`, which has never been a route. `/explorer/:type/:id`
 * matched the shape, so the click was not a 404 — it mounted the entity
 * explorer, which asked OpenAlex for a *work* id at the *authors* endpoint and
 * printed "Entity not found". A destination that is merely shaped like a route
 * is exactly the failure a person notices and a test never does, so the test
 * reads the router.
 */
const app = await readCode('../../App.tsx');
const destinations = await readCode('../../utils/searchDestinations.ts');
const { PUBLIC_ENTITY_TYPES } = await import('../../utils/publicNavigation.ts');

/** Route patterns App.tsx declares, minus the catch-all, which matches all. */
const ROUTES = [...app.matchAll(/path="([^"]+)"/g)]
  .map(match => match[1])
  .filter(path => path !== '*');

/** Path templates a surface navigates to, as segment lists. */
function navigationPaths(code: string) {
  return [...code.matchAll(/`(\/[^`]*)`/g)]
    .map(match => match[1].split('?')[0])
    .filter(path => !path.includes('://'))
    .map(path => path.replace(/\$\{[^}]*\}/g, '*'));
}

function routeAccepts(route: string, path: string) {
  const routeSegments = route.split('/').filter(Boolean);
  const pathSegments = path.split('/').filter(Boolean);
  if (routeSegments.length !== pathSegments.length) return false;
  return routeSegments.every((segment: string, index: number) => (
    // `:param` takes anything, including the literal `author` in
    // `/explorer/author/*`; a literal route segment has to be matched exactly.
    segment.startsWith(':') || segment === pathSegments[index]
  ));
}

test('every path a search result navigates to is a declared route', () => {
  assert.ok(ROUTES.length > 5, 'the routes were read out of App.tsx');
  for (const surface of [
    { name: 'the command palette', code: palette },
    { name: 'the search page', code: page },
    { name: 'the shared destinations', code: destinations },
  ]) {
    for (const path of navigationPaths(surface.code)) {
      assert.ok(
        ROUTES.some(route => routeAccepts(route, path)),
        `${surface.name}: "${path}" is not a route this app declares`,
      );
    }
  }
});

/**
 * `/explorer/:type/:id` matches on shape, which is why the test above passes
 * for `/explorer/paper/<id>` too: three segments, first one `explorer`. The
 * route accepted it and the explorer then asked OpenAlex for a work id at the
 * authors endpoint. So the rule that actually bites is that `:type` is not a
 * free slot — it is the closed set the explorer knows how to resolve.
 */
test('the explorer is only ever asked for a type it can resolve', () => {
  const types = new Set(PUBLIC_ENTITY_TYPES);
  assert.ok(types.has('author') && types.has('institution') && !types.has('paper'));

  for (const surface of [
    { name: 'the command palette', code: palette },
    { name: 'the search page', code: page },
    { name: 'the shared destinations', code: destinations },
  ]) {
    for (const path of navigationPaths(surface.code)) {
      const [root, type] = path.split('/').filter(Boolean);
      if (root !== 'explorer' || type === '*') continue;
      assert.ok(
        types.has(type),
        `${surface.name}: the entity explorer cannot resolve "${type}" (${path})`,
      );
    }
  }
});

/**
 * The palette's exit is `@radix-ui/react-presence` holding the sheet on screen
 * while `scSheetOut` runs — which it can only do while the component is still
 * mounted. `App.tsx` used to mount `SearchCommand` behind `searchOpen &&`, so
 * closing removed the whole tree in the same commit (measured in the browser:
 * gone from the DOM 2 ms after close, the closed state never observed),
 * and the exit `SearchCommand.css` describes had never played once. The lazy
 * chunk still waits for the first open; what must not happen is a second
 * unmount on every close.
 */
test('the palette stays mounted after its first open, so its exit can play', () => {
  const mount = app.match(/\{user && (\w+) && \(\s*<Suspense[\s\S]*?<SearchCommand[\s\S]*?\/>/);
  assert.ok(mount, 'App.tsx no longer mounts SearchCommand behind a `user && <flag>` guard');
  assert.notEqual(
    mount[1],
    'searchOpen',
    'mounting the palette on the open flag unmounts it on close, before its exit',
  );
  assert.match(mount[0], /open=\{searchOpen\}/, 'the open flag still reaches the dialog');
});

test('the palette clears its state on the way in, never on the way out', () => {
  // Mounted across closes (above), a reset on `!open` repaints the sheet with
  // the empty-query view while it is still fading out: the results vanish and
  // the suggestions cascade in, inside the 220 ms exit. Clearing on open, in a
  // layout effect, happens before the first paint of the next opening instead.
  assert.doesNotMatch(palette, /if \(!open\) reset\(\)/, 'the palette resets while its exit is still playing');
  assert.match(palette, /useLayoutEffect\(\(\) => \{\s*if \(open\) \{\s*reset\(\);/, 'the palette clears on open, before paint');
});

/**
 * The full-page search box's name (WCAG 3.3.2).
 *
 * Its only name used to be `placeholder`, which disappears from the
 * accessibility tree the instant anyone types into the field -- there was no
 * `<label>`, `aria-label` or `aria-labelledby` anywhere near it.
 */
test('the search page input is named by more than its placeholder', () => {
  const input = page.match(/<(?:input|Input)\s+type="search"[\s\S]*?\/>/);
  assert.ok(input, 'the search page input changed shape; update this test alongside it');
  assert.match(
    input[0],
    /className="search-input"/,
    'the matched <input> is no longer the main search field; update this test alongside it',
  );
  assert.match(
    input[0],
    /placeholder=\{'Search PaperTok\.\.\.'\}/,
    'the search input lost its placeholder; update this test alongside it',
  );
  assert.match(
    input[0],
    /aria-label=\{'[^']+'\}/,
    'the search input lost its aria-label and is named only by a placeholder again.',
  );
});

test('author, institution and topic rows hand their entity over in router state', async () => {
  const palette = await readFile(new URL('./SearchCommand.tsx', import.meta.url), 'utf8');
  assert.match(palette, /import \{ handoverFromSearchRow \} from '\.\.\/\.\.\/utils\/explorerHandover\.ts';/);
  assert.match(palette, /onSelect=\{\(\) => go\(path, \{ entity: handoverFromSearchRow\('author', author\), entityType: 'author' \}\)\}/);
  assert.match(palette, /onSelect=\{\(\) => go\(`\/explorer\/institution\/\$\{lastPathSegment\(institution\.id\)\}`, \{ entity: handoverFromSearchRow\('institution', institution\), entityType: 'institution' \}\)\}/);
  assert.match(palette, /onSelect=\{\(\) => go\(`\/explorer\/topic\/\$\{encodeURIComponent\(lastPathSegment\(concept\.id\)!\)\}`, \{ entity: handoverFromSearchRow\('topic', concept\), entityType: 'topic' \}\)\}/);
});

/**
 * A follow is keyed by `canonicalId`, and a project's id moved from the bare
 * grant code to the OpenAIRE id when it turned out a grant code is not unique
 * across funders. `followsEntity` still rescues the follows written before
 * that move — but only through its displayName fallback, which needs the
 * search row and the explorer to spell a project's name identically. They did
 * not: the explorer stored the acronym and the title, the row passed the
 * acronym alone, so an already-followed project came up with an unfilled
 * heart and a click on it wrote a second document for the same project. One
 * helper now spells the name for both surfaces, which is what keeps them from
 * drifting apart again.
 */
test('the search row and the explorer build a project name with the same helper', async () => {
  const explorer = await readCode('../Explorer/EntityExplorer.tsx');
  assert.match(
    page,
    /import \{ getProjectDisplayName \} from '\.\.\/\.\.\/utils\/entityMetadata\.ts';/,
    'the search page takes the name from the shared helper',
  );
  assert.match(
    page,
    /entity=\{\{ type: 'project', id: project\.id, displayName: getProjectDisplayName\(project\)/,
    'the follow the row writes carries the full name',
  );
  assert.match(
    explorer,
    /const displayName = getProjectDisplayName\(details\);/,
    'the explorer stores the same string the row now computes',
  );
  assert.doesNotMatch(
    page,
    /project\.acronym \|\| project\.title/,
    'the acronym-only name, which orphaned the follow, is gone from the page',
  );
});

// Execute the actual grouping renderer with React elements, without mounting
// providers or adding a production API for the test.
import * as React from 'react';
import ts from 'typescript';
import vm from 'node:vm';

const componentSource = await readFile(new URL('./SearchCommand.tsx', import.meta.url), 'utf8');
const groupingSource = componentSource.slice(componentSource.indexOf("  let firstResultValue = '';"), componentSource.indexOf('  const hasQuery ='));
const compileGrouping = ts.transpileModule(`(function () { ${groupingSource}; return renderedSections; })()`, {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
}).outputText;

function groupedRows(activeSection = 'all') {
  let chosen = activeSection;
  const data = { papers: Array.from({ length: 10 }, (_, id) => ({ id })), authors: Array.from({ length: 6 }, (_, id) => ({ id })), topics: [], institutions: [], projects: [] };
  const elements = vm.runInNewContext(compileGrouping, {
    React, results: data,
    rankedSections: Object.keys(data), activeSection,
    SECTION_ICONS: Object.fromEntries(Object.keys(data).map(key => [key, 'svg'])),
    copy: { papers: 'Papers', authors: 'Authors', topics: 'Topics', institutions: 'Institutions', projects: 'Projects' },
    sectionContent: Object.fromEntries(Object.entries(data).map(([section, items]) => [section, () => items.map(item => React.createElement('row', { key: item.id, value: `${section}-${item.id}` }))])),
    CommandGroup: 'group', CommandItem: 'row', ArrowRight: 'svg', changeSection: (value: string) => { chosen = value; },
  }) as React.ReactElement<{ children: React.ReactNode }>[];
  return { groups: elements.filter(Boolean), chosen: () => chosen };
}

test('All caps each section at four rows and Show all opens that type without navigation', () => {
  const rendered = groupedRows();
  assert.equal(rendered.groups.length, 2);
  const papers = React.Children.toArray(rendered.groups[0].props.children) as React.ReactElement<{ value: string; onSelect: () => void; children?: React.ReactNode }>[];
  assert.deepEqual(papers.slice(0, 4).map(row => row.props.value), ['papers-0', 'papers-1', 'papers-2', 'papers-3']);
  assert.equal(papers.length, 5);
  assert.equal(papers[4].props.value, 'show-all-papers');
  papers[4].props.onSelect();
  assert.equal(rendered.chosen(), 'papers');
  const expanded = groupedRows('papers');
  assert.equal(expanded.groups.length, 1);
  assert.equal(React.Children.toArray(expanded.groups[0].props.children).length, 10);
});

test('the type strip retains all sections when a settled count is zero', () => {
  const strip = palette.slice(palette.indexOf('<TabsList'), palette.indexOf('</TabsList>'));
  assert.match(strip, /\['all', \.\.\.orderedSections\]/);
  assert.doesNotMatch(strip, /\.filter\(/);
  assert.doesNotMatch(strip, /disabled=/, 'empty types remain available for the next query');
  assert.match(strip, /pending \? '—' : count/);
  assert.match(strip, /aria-label=/);
});

test('recents cannot display another account or save suggestions and unanswered queries', () => {
  assert.match(palette, /recentOwner\.uid === uid \? recentOwner\.queries : \[\]/);
  assert.match(palette, /recentOwner\.uid !== uid/);
  assert.match(palette, /!typedQuery\.current/);
  assert.match(palette, /resultsTerm !== query\.trim\(\)/);
  assert.match(palette, /totalResults === 0/);
  assert.match(palette, /setRecentOwner\(\{ uid, queries: \[\] \}\)/);
});

test('changing account clears recent queries before a closed palette can save them to the next UID', () => {
  const remember = componentSource.slice(componentSource.indexOf('  const rememberQuery ='), componentSource.indexOf('  // Cleared on the way in'));
  const openingEffect = componentSource.match(/useLayoutEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[open, reset, uid, recentOwner.uid\]\);/)?.[1];
  assert.ok(openingEffect);
  const code = ts.transpileModule(`${remember} ${openingEffect}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const uid of ['bob', undefined]) {
    let memory: { uid?: string; queries: string[] } = { uid: 'alice', queries: ['Private Alice query'] };
    const writes: string[] = [];
    vm.runInNewContext(code, {
      uid, open: false, recentOwner: memory, typedQuery: { current: true },
      hasSearched: true, resultsTerm: 'Private Alice query', query: 'Private Alice query', totalResults: 3, isPending: false,
      useEffectEvent: (callback: () => void) => callback,
      setRecentOwner: (value: typeof memory) => { memory = value; },
      updateRecentSearches: (owner: string) => { writes.push(owner); return ['Private Alice query']; },
    });
    assert.equal(memory.uid, uid);
    assert.equal(memory.queries.length, 0);
    assert.deepEqual(writes, []);
  }
});


test('the default keyboard target follows the selected view, preserving manual choices and touch deselection', () => {
  const expression = componentSource.match(/value: (hasQuery && !manualSelection[^,]+),/)?.[1];
  assert.ok(expression);
  const state = { hasQuery: true, firstResultValue: 'author-karpathy', selectedValue: 'paper-earlier' };
  assert.equal(vm.runInNewContext(expression, { ...state, manualSelection: false }), 'author-karpathy');
  assert.equal(vm.runInNewContext(expression, { ...state, manualSelection: true }), 'paper-earlier');
  assert.equal(vm.runInNewContext(expression, { ...state, selectedValue: '', manualSelection: false }), '');
});


test('typing preserves the selected type and the type strip is available before a query', () => {
  const changeQuery = componentSource.slice(componentSource.indexOf('  const changeQuery ='), componentSource.indexOf('  const renderFollow ='));
  assert.doesNotMatch(changeQuery, /setActiveSection/);
  const aboveStrip = componentSource.slice(componentSource.indexOf('</CommandInput>'), componentSource.indexOf('<TabsList'));
  assert.doesNotMatch(aboveStrip, /hasQuery/);
});
