/**
 * The combined search box, pinned where it can actually break.
 *
 * Papers, institutions, topics, projects and authors come from OpenAlex and
 * OpenAIRE over HTTP; people come from Firestore. Merging them into one box
 * means four things have to stay true, and none of them is visible from a
 * screenshot — each one fails silently, as a lie told to the person searching
 * or as a bill nobody notices.
 *
 * There are now two boxes: the full page (`SearchPage.jsx`) and the command
 * palette, which is a pair — `SearchCommand.jsx` paints and
 * `useEntitySearch.js` queries. The rules belong to the search, not to the
 * file that happened to implement it first, so every one of them below runs
 * against both surfaces. This file used to read a single file, which is
 * exactly how a second search box could have shipped violating all four with
 * nothing here turning red.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/** A file minus its comments, so a comment mentioning a name is not evidence. */
async function readCode(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
}

const page = await readCode('./SearchPage.jsx');
const palette = await readCode('./SearchCommand.jsx');
const paletteSearch = await readCode('../../hooks/useEntitySearch.js');

// The palette is checked as one body of code: the component owns what is
// painted and the hook owns what is queried, and every rule here is about the
// pair. `gate` and `personRow` are the one place each surface is allowed to
// differ, because the page gates on a filter pill and the palette on being
// open at all, and because they paint a person with different primitives.
const SURFACES = [
  {
    name: 'the search page',
    code: page,
    gate: /const usersRequested = activeSearchFilter === 'all' \|\| activeSearchFilter === 'users'/,
    gateWhy: 'the gate exists and names both filters that render the section',
    personRow: /data-section="users"[\s\S]*?data-section="institutions"/,
    personRowWhy: 'the users section is in the ordered sections',
  },
  {
    name: 'the command palette',
    code: `${palette}\n${paletteSearch}`,
    gate: /const usersRequested = open;/,
    gateWhy: 'the gate exists and names what makes the palette paint the section',
    personRow: /const userRow = \(person\) => \([\s\S]*?\n {2}\);/,
    personRowWhy: 'the person row is where it is expected to be',
  },
];

test('people are not fanned out with the external sources', () => {
  // `settleSearch` wraps the five HTTP sources and never rejects: on failure it
  // resolves with an empty array and the section name lands in
  // `unavailableSections`, which the banner reports. A Firestore read pushed
  // through the same envelope would inherit that banner — including the branch
  // that says "OpenAlex is temporarily unavailable", which would then be a
  // sentence the page made up.
  for (const surface of SURFACES) {
    const settled = surface.code.match(/settleSearch\([\s\S]*?\)/g) || [];
    assert.ok(settled.length >= 5, `${surface.name}: the external sources still go through settleSearch`);
    for (const call of settled) {
      assert.doesNotMatch(call, /searchUsers/, `${surface.name}: a Firestore read must not join the OpenAlex banner`);
    }
    const issue = surface.code.match(/setSearchIssue\([\s\S]{0,200}?\)/g) || [];
    for (const call of issue) {
      assert.doesNotMatch(call, /user/i, `${surface.name}: the banner speaks only for the external sources`);
    }
  }
});

test('people are looked up on their own clock, never the paper one', () => {
  // 320 ms is fine against APIs that do not bill us. Firestore is our own quota,
  // and the design fixed 400 ms with a two-character floor so that one typed
  // word costs one search — not one per letter.
  for (const surface of SURFACES) {
    assert.match(surface.code, /USER_SEARCH_DEBOUNCE_MS/, `${surface.name}: the user search uses its own debounce`);
    const userEffect = surface.code.match(
      /const term = normalizeUserSearchTerm\(query\);[\s\S]*?\}, \[query, usersRequested, performUserSearch\]\);/,
    );
    assert.ok(userEffect, `${surface.name}: the user search effect is where it is expected to be`);
    assert.match(userEffect[0], /USER_SEARCH_DEBOUNCE_MS/);
    // The word boundary is doing real work: without it this matches the tail of
    // USER_SEARCH_DEBOUNCE_MS and the assertion can never fail. In the palette
    // it does more still — the paper clock is a constant in the very same file.
    assert.doesNotMatch(userEffect[0], /\bSEARCH_DEBOUNCE_MS\b/, `${surface.name}: not the paper clock`);
    assert.match(userEffect[0], /isSearchableTerm/, `${surface.name}: and below two characters it does not fire`);
  }
});

test('a search is only paid for when a section is going to show it', () => {
  // The Users pill is a spend gate as much as a filter: with any other filter
  // selected the section is not rendered, so the two reads are not spent. The
  // palette has no pills and one view, so what decides whether the section is
  // going to be painted is whether the palette is on screen at all.
  for (const surface of SURFACES) {
    assert.match(surface.code, surface.gate, `${surface.name}: ${surface.gateWhy}`);
    assert.match(
      surface.code,
      /if \(!usersRequested \|\| !isSearchableTerm\(term\)\) return undefined;/,
      `${surface.name}: and no query is issued when the section is not showing`,
    );
  }

  // The palette splits the rule over two files — the component knows what it
  // paints, the hook spends the read — so the flag has to travel, and it has to
  // arrive off by default. A caller that forgets it gets no people, never a
  // silent Firestore bill.
  assert.match(palette, /useEntitySearch\(\{ usersRequested \}\)/, 'the palette hands its gate to the hook');
  assert.match(
    paletteSearch,
    /export function useEntitySearch\(\{ usersRequested = false \} = \{\}\)/,
    'and the hook searches for nobody until it is asked to',
  );
});

test('a signed-out visitor is told the truth, before any request is made', () => {
  // The rules refuse a signed-out query and the service refuses it before the
  // network. What the page must not do is route that refusal into the failure
  // state, which says the search is broken — it is not broken, it is closed to
  // them, and the difference is a sign-in button instead of a dead end. The
  // palette only ever mounts with a session, so for it this is a state nobody
  // should reach — which is a reason to keep it silent, not to invent an error.
  for (const surface of SURFACES) {
    const guard = surface.code.match(/if \(!user\) \{[\s\S]*?\}/);
    assert.ok(guard, `${surface.name}: the session is checked before the request`);
    assert.match(guard[0], /needs-session/);
    assert.match(surface.code, /UserSearchAuthRequiredError[\s\S]{0,200}?needs-session/,
      `${surface.name}: and the service error maps to the same state, never to failed`);
  }
});

test('a person row costs no read beyond the one that found them', () => {
  // The index document carries the handle and the name, so the row paints with
  // nothing else. A follow button here would need to know whether you already
  // follow them: one read per row, which is the bug family R7 documents. The
  // profile the row opens is where following lives — and in the palette that
  // button is one line away, on every other kind of row.
  for (const surface of SURFACES) {
    const section = surface.code.match(surface.personRow);
    assert.ok(section, `${surface.name}: ${surface.personRowWhy}`);
    assert.doesNotMatch(section[0], /FollowButton|renderFollow/, `${surface.name}: no follow button on a person row`);
    assert.doesNotMatch(section[0], /photo/i, `${surface.name}: and no photo: the index does not carry one`);
  }
});

test('the palette has a people channel at all', () => {
  // The hole this file had: every rule above read one file, so a second search
  // box could ship with no people in it — or with people wired through the
  // OpenAlex envelope — and nothing here would have gone red. A section the
  // palette can never paint is the same absence as a section it paints last.
  assert.match(paletteSearch, /searchUsers/, 'the palette queries people');
  assert.match(palette, /const SECTIONS = \[[^\]]*'users'[^\]]*\]/, 'and paints them as one of its sections');
});

test('the users section is a known section, or it sinks to the bottom forever', async () => {
  // getSearchSectionOrder scores an unknown section 99. A section rendered by
  // the page but missing from the ordering module is last on every search,
  // silently, which is the kind of thing nobody reports as a bug.
  const relevance = await readFile(new URL('../../utils/searchRelevance.js', import.meta.url), 'utf8');
  const order = relevance.match(/const DEFAULT_SECTION_ORDER = \[(.*?)\]/);
  assert.ok(order, 'the default order is where it is expected to be');
  assert.match(order[1], /'users'/);
});

test('the search never announces itself as unavailable', () => {
  // The page saying "the search is temporarily unavailable" is the page
  // denying its own existence — and it said it while results sat underneath,
  // because `hasResults` did not count the people it had just found. A notice
  // names the provider that went down, or it does not appear.
  for (const surface of SURFACES) {
    assert.doesNotMatch(surface.code, /Search is temporarily unavailable/, surface.name);
    assert.doesNotMatch(surface.code, /La búsqueda no está disponible/, surface.name);
  }
});

test('both surfaces settle once', () => {
  // Results used to be revealed in two phases — whatever had arrived by 520 ms,
  // then every straggler painting on its own — which assembled the search on
  // screen over several seconds and reshuffled the ranking as it went.
  //
  // The page was fixed first and the palette was deliberately left out, with
  // the reason written down right here: it "opens over the feed with no
  // skeleton to hide behind", so waiting on the slowest of six sources before
  // showing anything was the worse trade there. That reason is gone — the
  // palette has a skeleton now, which is exactly what buys the wait — and the
  // exception went with it.
  for (const [name, code] of [['the page', page], ['the palette', paletteSearch]]) {
    assert.doesNotMatch(code, /SEARCH_INITIAL_REVEAL_MS/, name);
    assert.doesNotMatch(code, /Promise\.race/, `${name}: no partial reveal race`);
    assert.match(code, /await Promise\.all\(tasks\)/, `${name}: one settle for the whole fan-out`);
  }
});

test('neither surface paints a section while an answer is still owed', () => {
  // The five external sources land in one commit, but people run on their own
  // 400 ms clock and used to arrive alone, after the rest, pushing everything
  // down under a reader who had already started reading. So the gate is the
  // pending state that covers BOTH channels, never the external one alone.
  assert.match(page, /hasVisibleResults && !searchPending/, 'the page gates its sections');
  assert.match(palette, /!searchPending && renderedSections/, 'the palette gates its sections');
  // And what it gates is the real list, not some other variable that happens to
  // be named like one: `renderedSections` is built from the ranked order.
  assert.match(
    palette,
    /const renderedSections = orderedSections\.map\(/,
    'the gated value is the ranked section list',
  );
  // And what stands in the gap is a skeleton, not an empty sheet: waiting for
  // every source is only tolerable if the wait has a shape.
  assert.match(page, /className="search-loading-state"/, 'the page shows a skeleton while it waits');
  assert.match(palette, /className="sc-skeleton"/, 'the palette shows a skeleton while it waits');
});

test('a search never paints on top of the last one', () => {
  // The reveal used to apply only the sections that had resolved, on top of
  // whatever the previous query had left on screen. A source that ran out its
  // timeout never wrote its section, so its old rows survived the whole next
  // search: proteins under Papers, quantum physics under Authors, and nothing
  // on screen saying they answered different questions.
  assert.match(
    paletteSearch,
    /const revealedResults = \{ \.\.\.EMPTY_RESULTS \};/,
    'a search paints from empty, never on top of the last one',
  );
  assert.match(paletteSearch, /setResults\(revealedResults\);/, 'and in one commit');
  // Still not fixed by clearing on the way in, which would blink the palette to
  // nothing on every keystroke. Rows survive the debounce gap — the window
  // before the pending gate above closes — and say they are the old ones.
  assert.match(paletteSearch, /const isStale = /, 'the kept rows know they are the old ones');
  assert.match(palette, /className=\{isStale \? 'sc-group--stale' : undefined\}/, 'and say so on screen');
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

test('the wait covers the people channel, not just the external one', () => {
  // The skeleton used to die the moment the people query merely started, at
  // 400 ms, leaving Firestore's "nobody matches that" alone on screen until the
  // five external sources landed a second later.
  for (const surface of SURFACES) {
    const pending = surface.code.match(/const peoplePending = [\s\S]{0,240}?;/);
    assert.ok(pending, `${surface.name}: the people channel takes part in the pending state`);
    assert.match(pending[0], /userStatus/, surface.name);
    assert.match(surface.code, /const searchPending = [\s\S]{0,200}?peoplePending/, surface.name);
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
function withoutComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Innermost `selector { body }` pairs; at-rule wrappers fall out on their own. */
function innermostRules(css) {
  const rules = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = pattern.exec(css)) !== null) {
    rules.push({ selectors: match[1].trim().split(',').map(one => one.trim()).filter(Boolean), body: match[2] });
  }
  return rules;
}

/** The body of every `prefers-reduced-motion: reduce` block, brace-balanced. */
function reducedMotionBlocks(css) {
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

for (const stylesheet of ['./SearchPage.css', './SearchCommand.css']) {
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

    assert.ok(atRisk.length > 0, 'expected to have found the animated entrances at all');
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

test('the outage description speaks only for the external sources', () => {
  // Mirrors the rule above for setSearchIssue: a Firestore hiccup must not be
  // able to reach a banner that names OpenAlex.
  const described = page.match(/describeSearchOutage\([\s\S]{0,200}?\)/g) || [];
  assert.ok(described.length > 0, 'the banner still goes through the outage module');
  for (const call of described) {
    assert.doesNotMatch(call, /user/i, 'people never enter the provider outage');
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
  function branch(block, filterName) {
    const match = block.match(new RegExp(`activeSearchFilter === '${filterName}'\\s*\\n\\s*\\?\\s*([^\\n]+)`));
    return match ? match[1].trim() : null;
  }

  // "all": hasVisibleResults reads through `hasResults` (defined just above
  // the ternary) rather than naming cleanOrcid inline, so that indirection is
  // resolved by hand instead of by the generic loop below.
  assert.equal(
    branch(hasVisibleBlock, 'all'),
    'hasResults || userResults.length > 0',
    'hasVisibleResults\' "all" branch changed shape; update this test alongside it',
  );
  assert.match(
    page,
    /const hasResults = hasSearchSectionResults \|\| !!cleanOrcid;/,
    'hasResults no longer folds in a direct ORCID hit -- "all" would silently stop counting one',
  );
  const countAllBranch = countBlock.match(
    /activeSearchFilter === 'all'\s*\n\s*\?\s*([\s\S]*?)\n\s*: activeSearchFilter === 'users'/,
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
  for (const filterName of ['users', 'papers', 'institutions', 'authors', 'projects']) {
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
const app = await readCode('../../App.jsx');
const destinations = await readCode('../../utils/searchDestinations.js');
const { PUBLIC_ENTITY_TYPES } = await import('../../utils/publicNavigation.js');

/** Route patterns App.jsx declares, minus the catch-all, which matches all. */
const ROUTES = [...app.matchAll(/path="([^"]+)"/g)]
  .map(match => match[1])
  .filter(path => path !== '*');

/** Path templates a surface navigates to, as segment lists. */
function navigationPaths(code) {
  return [...code.matchAll(/`(\/[^`]*)`/g)]
    .map(match => match[1].split('?')[0])
    .filter(path => !path.includes('://'))
    .map(path => path.replace(/\$\{[^}]*\}/g, '*'));
}

function routeAccepts(route, path) {
  const routeSegments = route.split('/').filter(Boolean);
  const pathSegments = path.split('/').filter(Boolean);
  if (routeSegments.length !== pathSegments.length) return false;
  return routeSegments.every((segment, index) => (
    // `:param` takes anything, including the literal `author` in
    // `/explorer/author/*`; a literal route segment has to be matched exactly.
    segment.startsWith(':') || segment === pathSegments[index]
  ));
}

test('every path a search result navigates to is a declared route', () => {
  assert.ok(ROUTES.length > 5, 'the routes were read out of App.jsx');
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
 * mounted. `App.jsx` used to mount `SearchCommand` behind `searchOpen &&`, so
 * closing removed the whole tree in the same commit (measured in the browser:
 * gone from the DOM 2 ms after close, the closed state never observed),
 * and the exit `SearchCommand.css` describes had never played once. The lazy
 * chunk still waits for the first open; what must not happen is a second
 * unmount on every close.
 */
test('the palette stays mounted after its first open, so its exit can play', () => {
  const mount = app.match(/\{user && (\w+) && \(\s*<Suspense[\s\S]*?<SearchCommand[\s\S]*?\/>/);
  assert.ok(mount, 'App.jsx no longer mounts SearchCommand behind a `user && <flag>` guard');
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
  assert.match(palette, /useLayoutEffect\(\(\) => \{\s*if \(open\) reset\(\);/, 'the palette clears on open, before paint');
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
    /placeholder=\{isEnglish \? 'Search PaperTok\.\.\.' : 'Buscar en PaperTok\.\.\.'\}/,
    'the search input lost its placeholder; update this test alongside it',
  );
  assert.match(
    input[0],
    /aria-label=\{isEnglish \? '[^']+' : '[^']+'\}/,
    'the search input lost its aria-label and is named only by a placeholder again.',
  );
});
