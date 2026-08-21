import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SECTION_SOURCES,
  describeSearchOutage,
  formatRetryDelay,
  joinNames,
  outageAffectsFilter,
} from './searchOutage.js';

/* --- Attribution ------------------------------------------------------------
   The banner named OpenAlex for failures that belonged to other providers.
   `institutions` is ROR and `projects` is OpenAIRE; only papers, authors and
   topics are OpenAlex. */

test('each section is attributed to the provider that actually serves it', () => {
  assert.equal(SECTION_SOURCES.papers, 'openalex');
  assert.equal(SECTION_SOURCES.authors, 'openalex');
  assert.equal(SECTION_SOURCES.topics, 'openalex');
  assert.equal(SECTION_SOURCES.institutions, 'ror');
  assert.equal(SECTION_SOURCES.projects, 'openaire');
});

test('a failure outside OpenAlex never names OpenAlex', () => {
  const outage = describeSearchOutage({ sections: ['projects'] });
  assert.deepEqual(outage.sources, ['openaire']);
  assert.equal(outage.involvesOpenAlex, false);
  assert.deepEqual(outage.sectionsBySource.openaire, ['projects']);
});

test('ROR going down is reported as ROR', () => {
  const outage = describeSearchOutage({ sections: ['institutions'] });
  assert.deepEqual(outage.sources, ['ror']);
  assert.equal(outage.involvesOpenAlex, false);
});

test('several providers are listed in a stable order', () => {
  const first = describeSearchOutage({ sections: ['projects', 'institutions', 'papers'] });
  const second = describeSearchOutage({ sections: ['institutions', 'papers', 'projects'] });
  assert.deepEqual(first.sources, ['openalex', 'ror', 'openaire']);
  assert.deepEqual(first.sources, second.sources, 'input order must not reshuffle the banner');
});

test('nothing wrong reports nothing', () => {
  assert.equal(describeSearchOutage({ sections: [] }), null);
  assert.equal(describeSearchOutage(), null);
});

test('unknown section names are ignored rather than inventing a provider', () => {
  assert.equal(describeSearchOutage({ sections: ['users'] }), null);
});

/* --- "Involved" and "rate limited" are different facts ------------------------
   Only one of them can promise a time, so the banner must not conflate a plain
   timeout with OpenAlex actually throttling us. */

test('a timeout on an OpenAlex section involves it without claiming a rate limit', () => {
  const outage = describeSearchOutage({ sections: ['papers'] });
  assert.equal(outage.involvesOpenAlex, true);
  assert.equal(outage.rateLimited, false);
  assert.equal(outage.retryAtMs, null, 'no rate limit, no promise of a time');
});

test('a rate limit is reported even when no section registered a failure', () => {
  // `topics` swallows its own failure by falling back to local concepts, so the
  // live client health is the authority — this is the regression the whole
  // module exists for.
  const outage = describeSearchOutage({ sections: [], rateLimited: true });
  assert.deepEqual(outage.sources, ['openalex']);
  assert.equal(outage.rateLimited, true);
  assert.equal(outage.involvesOpenAlex, true);
});

/* --- The wait is an instant, not a frozen duration --------------------------- */

test('the wait is returned as an absolute instant so a countdown can tick', () => {
  const outage = describeSearchOutage({
    sections: ['papers'],
    rateLimited: true,
    retryAfterMs: 8 * 3_600_000,
    now: 1_000,
  });
  assert.equal(outage.retryAtMs, 1_000 + 8 * 3_600_000);
});

test('a rate limit with no figure promises no time', () => {
  const outage = describeSearchOutage({ sections: ['papers'], rateLimited: true, retryAfterMs: 0 });
  assert.equal(outage.rateLimited, true);
  assert.equal(outage.retryAtMs, null);
});

/* --- Which views the outage is actually true for ----------------------------- */

test('an outage follows the pills it really describes', () => {
  const openAlexDown = describeSearchOutage({ sections: [], rateLimited: true });
  assert.equal(outageAffectsFilter(openAlexDown, 'all'), true);
  assert.equal(outageAffectsFilter(openAlexDown, 'papers'), true);
  assert.equal(outageAffectsFilter(openAlexDown, 'authors'), true);
  assert.equal(outageAffectsFilter(openAlexDown, 'projects'), false, 'OpenAIRE is fine');
});

test('people are never covered by a provider outage', () => {
  const everythingDown = describeSearchOutage({
    sections: ['papers', 'institutions', 'projects'],
  });
  assert.equal(outageAffectsFilter(everythingDown, 'users'), false);
  assert.equal(outageAffectsFilter(null, 'all'), false);
});

/* --- The wait, worded -------------------------------------------------------- */

test('the wait is shown in the coarsest unit that is still true', () => {
  assert.equal(formatRetryDelay(45_000), '~45 s');
  assert.equal(formatRetryDelay(15 * 60_000), '~15 min');
  assert.equal(formatRetryDelay(8 * 3_600_000), '~8 h');
});

test('the boundaries do not produce absurd figures', () => {
  assert.equal(formatRetryDelay(89_000), '~89 s');
  assert.equal(formatRetryDelay(90_000), '~2 min');
  assert.equal(formatRetryDelay(89 * 60_000), '~89 min');
  assert.equal(formatRetryDelay(90 * 60_000), '~2 h');
  assert.equal(formatRetryDelay(400), '~1 s', 'sub-second waits never round down to zero');
});

test('a missing or spent figure yields no sentence at all', () => {
  assert.equal(formatRetryDelay(0), null);
  assert.equal(formatRetryDelay(-1), null);
  assert.equal(formatRetryDelay(undefined), null);
  assert.equal(formatRetryDelay(Number.NaN), null);
  assert.equal(formatRetryDelay(Number.POSITIVE_INFINITY), null);
});

/* --- Lists read as Spanish, not as English with Spanish words ---------------- */

test('a list of one or none needs no conjunction', () => {
  assert.equal(joinNames([]), '');
  assert.equal(joinNames(['OpenAIRE']), 'OpenAIRE');
  assert.equal(joinNames([null, 'ROR', undefined]), 'ROR');
});

test('Spanish swaps y for e before the i sound', () => {
  assert.equal(joinNames(['autores', 'instituciones']), 'autores e instituciones');
  assert.equal(joinNames(['papers', 'historia']), 'papers e historia');
  assert.equal(joinNames(['papers', 'temas']), 'papers y temas');
  assert.equal(joinNames(['agua', 'hielo']), 'agua y hielo', 'a diphthong keeps y');
});

test('English always joins with and', () => {
  assert.equal(joinNames(['authors', 'institutions'], true), 'authors and institutions');
  assert.equal(joinNames(['papers', 'authors', 'topics'], true), 'papers, authors and topics');
});

test('three or more items keep the commas', () => {
  assert.equal(joinNames(['papers', 'autores', 'temas']), 'papers, autores y temas');
});
