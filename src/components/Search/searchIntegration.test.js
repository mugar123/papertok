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

test('the page settles once', () => {
  // Results used to be revealed in two phases — whatever had arrived by 520 ms,
  // then every straggler painting on its own — which assembled the page on
  // screen over several seconds and reshuffled the ranking as it went.
  //
  // Page only. The palette keeps the two-phase reveal on purpose: it opens over
  // the feed with no skeleton to hide behind, so waiting on the slowest of six
  // sources before showing anything is the worse trade there. What it may not
  // do is let the two phases mix two searches — the test below.
  assert.doesNotMatch(page, /SEARCH_INITIAL_REVEAL_MS/);
  assert.doesNotMatch(page, /Promise\.race/, 'no partial reveal race');
  assert.match(page, /await Promise\.all\(tasks\)/, 'one settle for the whole fan-out');
});

test('the palette never shows two searches at once', () => {
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
  // Not fixed by clearing on the way in, which would blink the palette to
  // nothing on every keystroke: the previous answer stays up until the commit,
  // marked as the previous answer.
  assert.match(paletteSearch, /const isStale = /, 'the kept rows know they are the old ones');
  assert.match(palette, /className=\{isStale \? 'sc-group--stale' : undefined\}/, 'and say so on screen');
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

test('the outage description speaks only for the external sources', () => {
  // Mirrors the rule above for setSearchIssue: a Firestore hiccup must not be
  // able to reach a banner that names OpenAlex.
  const described = page.match(/describeSearchOutage\([\s\S]{0,200}?\)/g) || [];
  assert.ok(described.length > 0, 'the banner still goes through the outage module');
  for (const call of described) {
    assert.doesNotMatch(call, /user/i, 'people never enter the provider outage');
  }
});
