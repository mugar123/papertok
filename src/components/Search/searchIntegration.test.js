/**
 * The combined search box, pinned where it can actually break.
 *
 * Papers, institutions, topics, projects and authors come from OpenAlex and
 * OpenAIRE over HTTP; people come from Firestore. Merging them into one box
 * means four things have to stay true, and none of them is visible from a
 * screenshot — each one fails silently, as a lie told to the person searching
 * or as a bill nobody notices.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./SearchPage.jsx', import.meta.url), 'utf8');
/** The file minus comments, so a comment mentioning a name is not evidence. */
const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('people are not fanned out with the external sources', async () => {
  // `settleSearch` wraps the five HTTP sources and never rejects: on failure it
  // resolves with an empty array and the section name lands in
  // `unavailableSections`, which the banner reports. A Firestore read pushed
  // through the same envelope would inherit that banner — including the branch
  // that says "OpenAlex is temporarily unavailable", which would then be a
  // sentence the page made up.
  const settled = code.match(/settleSearch\([\s\S]*?\)/g) || [];
  assert.ok(settled.length >= 5, 'the external sources still go through settleSearch');
  for (const call of settled) {
    assert.doesNotMatch(call, /searchUsers/, 'a Firestore read must not join the OpenAlex banner');
  }
  const issue = code.match(/setSearchIssue\([\s\S]{0,200}?\)/g) || [];
  for (const call of issue) {
    assert.doesNotMatch(call, /user/i, 'the banner speaks only for the external sources');
  }
});

test('people are looked up on their own clock, never the paper one', () => {
  // 320 ms is fine against APIs that do not bill us. Firestore is our own quota,
  // and the design fixed 400 ms with a two-character floor so that one typed
  // word costs one search — not one per letter.
  assert.match(code, /USER_SEARCH_DEBOUNCE_MS/, 'the user search uses its own debounce');
  const userEffect = code.match(
    /const term = normalizeUserSearchTerm\(query\);[\s\S]*?\}, \[query, usersRequested, performUserSearch\]\);/,
  );
  assert.ok(userEffect, 'the user search effect is where it is expected to be');
  assert.match(userEffect[0], /USER_SEARCH_DEBOUNCE_MS/);
  // The word boundary is doing real work: without it this matches the tail of
  // USER_SEARCH_DEBOUNCE_MS and the assertion can never fail.
  assert.doesNotMatch(userEffect[0], /\bSEARCH_DEBOUNCE_MS\b/, 'not the paper clock');
  assert.match(userEffect[0], /isSearchableTerm/, 'and below two characters it does not fire');
});

test('a search is only paid for when a section is going to show it', () => {
  // The Users pill is a spend gate as much as a filter: with any other filter
  // selected the section is not rendered, so the two reads are not spent.
  assert.match(
    code,
    /const usersRequested = activeSearchFilter === 'all' \|\| activeSearchFilter === 'users'/,
    'the gate exists and names both filters that render the section',
  );
  assert.match(
    code,
    /if \(!usersRequested \|\| !isSearchableTerm\(term\)\) return undefined;/,
    'and no query is issued when the section is not showing',
  );
});

test('a signed-out visitor is told the truth, before any request is made', () => {
  // The rules refuse a signed-out query and the service refuses it before the
  // network. What the page must not do is route that refusal into the failure
  // state, which says the search is broken — it is not broken, it is closed to
  // them, and the difference is a sign-in button instead of a dead end.
  const guard = code.match(/if \(!user\) \{[\s\S]*?\}/);
  assert.ok(guard, 'the session is checked before the request');
  assert.match(guard[0], /needs-session/);
  assert.match(code, /UserSearchAuthRequiredError[\s\S]{0,200}?needs-session/,
    'and the service error maps to the same state, never to failed');
});

test('a person row costs no read beyond the one that found them', () => {
  // The index document carries the handle and the name, so the row paints with
  // nothing else. A follow button here would need to know whether you already
  // follow them: one read per row, which is the bug family R7 documents. The
  // profile the row opens is where following lives.
  const section = code.match(/data-section="users"[\s\S]*?data-section="institutions"/);
  assert.ok(section, 'the users section is in the ordered sections');
  assert.doesNotMatch(section[0], /FollowButton/, 'no follow button on a person row');
  assert.doesNotMatch(section[0], /photo/i, 'and no photo: the index does not carry one');
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
