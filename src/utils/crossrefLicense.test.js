import test from 'node:test';
import assert from 'node:assert/strict';
import { licenseSlugFromUrl, openLicenseFromCrossref } from './crossrefLicense.js';

// Licence arrays exactly as Crossref served them on 2026-09-23.
const WILEY_VOR = {
  DOI: '10.1002/jmrs.70126',
  license: [
    { start: { 'date-parts': [[2026, 9, 18]], 'date-time': '2026-09-18T00:00:00Z', timestamp: 1789689600000 }, 'content-version': 'vor', 'delay-in-days': 0, URL: 'http://creativecommons.org/licenses/by/4.0/' },
    { start: { 'date-parts': [[2026, 9, 18]], 'date-time': '2026-09-18T00:00:00Z', timestamp: 1789689600000 }, 'content-version': 'tdm', 'delay-in-days': 0, URL: 'http://doi.wiley.com/10.1002/tdm_license_1.1' },
  ],
};

// A subscription article: every URL is a licence, none of them is open.
const ELSEVIER_SUBSCRIPTION = {
  DOI: '10.1016/j.jmb.2026.170030',
  license: [
    { start: { 'date-parts': [[2026, 9, 1]], 'date-time': '2026-09-01T00:00:00Z', timestamp: 1788220800000 }, 'content-version': 'tdm', 'delay-in-days': 0, URL: 'https://www.elsevier.com/tdm/userlicense/1.0/' },
    { start: { 'date-parts': [[2026, 9, 1]], 'date-time': '2026-09-01T00:00:00Z', timestamp: 1788220800000 }, 'content-version': 'tdm', 'delay-in-days': 0, URL: 'https://www.elsevier.com/legal/tdmrep-license' },
    { start: { 'date-parts': [[2026, 9, 1]], 'date-time': '2026-09-01T00:00:00Z', timestamp: 1788220800000 }, 'content-version': 'stm-asf', 'delay-in-days': 0, URL: 'https://doi.org/10.15223/policy-017' },
    { start: { 'date-parts': [[2026, 9, 1]], 'date-time': '2026-09-01T00:00:00Z', timestamp: 1788220800000 }, 'content-version': 'stm-asf', 'delay-in-days': 0, URL: 'https://doi.org/10.15223/policy-029' },
  ],
};

// Open, but listed after two text-mining licences, and 252 days "late" because
// Crossref counts the delay from `issued` (January), not from going online.
const ELSEVIER_OPEN_AFTER_TDM = {
  DOI: '10.1016/j.clinsp.2026.101156',
  license: [
    { start: { 'date-parts': [[2026, 1, 1]], 'date-time': '2026-01-01T00:00:00Z', timestamp: 1767225600000 }, 'content-version': 'tdm', 'delay-in-days': 0, URL: 'https://www.elsevier.com/tdm/userlicense/1.0/' },
    { start: { 'date-parts': [[2026, 1, 1]], 'date-time': '2026-01-01T00:00:00Z', timestamp: 1767225600000 }, 'content-version': 'tdm', 'delay-in-days': 0, URL: 'https://www.elsevier.com/legal/tdmrep-license' },
    { start: { 'date-parts': [[2026, 9, 10]], 'date-time': '2026-09-10T00:00:00Z', timestamp: 1788998400000 }, 'content-version': 'vor', 'delay-in-days': 252, URL: 'http://creativecommons.org/licenses/by/4.0/' },
  ],
};

const UNSPECIFIED_VERSION = {
  DOI: '10.14202/vetworld.2026.4115-4132',
  license: [
    { start: { 'date-parts': [[2026, 9, 18]], 'date-time': '2026-09-18T00:00:00Z', timestamp: 1789689600000 }, 'content-version': 'unspecified', 'delay-in-days': 0, URL: 'http://creativecommons.org/licenses/by/4.0/' },
  ],
};

// Springer Nature's usual deposit: CC BY on the accepted manuscript and for
// text mining, nothing on the version of record.
const MANUSCRIPT_ONLY = {
  DOI: '10.1186/s12981-026-00908-y',
  license: [
    { start: { 'date-parts': [[2026, 7, 4]], 'date-time': '2026-07-04T00:00:00Z', timestamp: 1783123200000 }, 'content-version': 'tdm', 'delay-in-days': 0, URL: 'https://creativecommons.org/licenses/by/4.0' },
    { start: { 'date-parts': [[2026, 7, 4]], 'date-time': '2026-07-04T00:00:00Z', timestamp: 1783123200000 }, 'content-version': 'am', 'delay-in-days': 0, URL: 'https://creativecommons.org/licenses/by/4.0' },
  ],
};

const SEPT_23 = Date.parse('2026-09-23T12:00:00Z');

test('reads the Creative Commons licence on the version of record', () => {
  assert.deepEqual(openLicenseFromCrossref(WILEY_VOR, { now: SEPT_23 }), {
    url: 'http://creativecommons.org/licenses/by/4.0/',
    slug: 'cc-by',
    start: '2026-09-18T00:00:00Z',
  });
});

test('a publisher text-mining licence is not an open licence', () => {
  // The URL that used to count as open access: the first one with a scheme.
  assert.equal(openLicenseFromCrossref(ELSEVIER_SUBSCRIPTION, { now: SEPT_23 }), null);
});

test('finds the open licence behind the text-mining ones, dated by its start and not its delay', () => {
  assert.deepEqual(openLicenseFromCrossref(ELSEVIER_OPEN_AFTER_TDM, { now: SEPT_23 }), {
    url: 'http://creativecommons.org/licenses/by/4.0/',
    slug: 'cc-by',
    start: '2026-09-10T00:00:00Z',
  });
});

test('a licence that has not started yet is an embargo, not an open paper', () => {
  assert.equal(openLicenseFromCrossref(ELSEVIER_OPEN_AFTER_TDM, { now: Date.parse('2026-09-01T00:00:00Z') }), null);
});

test('an unspecified content version counts as the version of record', () => {
  assert.equal(openLicenseFromCrossref(UNSPECIFIED_VERSION, { now: SEPT_23 })?.slug, 'cc-by');
});

test('a licence on the accepted manuscript alone does not open the published version', () => {
  // A rights-retention subscription article carries exactly this, so reading
  // it as open would claim a free version of record that is behind a paywall.
  assert.equal(openLicenseFromCrossref(MANUSCRIPT_ONLY, { now: SEPT_23 }), null);
});

test('a record without licences, or without a record, says nothing', () => {
  assert.equal(openLicenseFromCrossref(null), null);
  assert.equal(openLicenseFromCrossref({ DOI: '10.1/x' }), null);
  assert.equal(openLicenseFromCrossref({ license: [{ 'content-version': 'vor' }] }, { now: SEPT_23 }), null);
});

test('names each Creative Commons licence the way Unpaywall does', () => {
  const cases = [
    ['http://creativecommons.org/licenses/by/4.0/', 'cc-by'],
    ['https://creativecommons.org/licenses/by/4.0', 'cc-by'],
    ['https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode', 'cc-by-nc-nd'],
    ['http://creativecommons.org/licenses/by-sa/3.0/igo/', 'cc-by-sa'],
    ['https://www.creativecommons.org/licenses/by-nc/4.0/', 'cc-by-nc'],
    ['https://creativecommons.org/publicdomain/zero/1.0/', 'cc0'],
    ['https://creativecommons.org/publicdomain/mark/1.0/', 'public-domain'],
    ['https://creativecommons.org.evil.example/licenses/by/4.0/', null],
    ['https://www.elsevier.com/tdm/userlicense/1.0/', null],
    ['https://creativecommons.org/about/', null],
    ['not a url', null],
  ];
  for (const [url, slug] of cases) assert.equal(licenseSlugFromUrl(url), slug, url);
});
