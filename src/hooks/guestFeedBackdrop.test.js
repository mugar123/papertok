import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { guestFeedLoadDecision } from './useGuestFeed.js';

// Behind the mandatory welcome sheet the guest feed used to load the default
// sample — six fields the visitor never chose, with bioRxiv, enrichment,
// figures and KaTeX — about twenty requests for a backdrop nobody can read,
// thrown away the moment the visitor answered (audit 2026-09-23, issue 11a;
// decision of 2026-09-23: load nothing until the answer).
test('nothing loads until the feed is enabled, and the first load after it is not a refresh', () => {
  assert.equal(guestFeedLoadDecision({ enabled: false, previousKey: null, planKey: 'default' }), null);
  assert.deepEqual(guestFeedLoadDecision({ enabled: true, previousKey: null, planKey: 'cs+med' }), { refresh: false });
  assert.deepEqual(guestFeedLoadDecision({ enabled: true, previousKey: 'cs+med', planKey: 'cs+med+bio' }), { refresh: true });
  assert.equal(guestFeedLoadDecision({ enabled: true, previousKey: 'cs+med', planKey: 'cs+med' }), null);
});

const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('the guest page enables its feed once the visitor has answered', () => {
  const page = stripComments(readFileSync(new URL('../components/Public/GuestFeedPage.jsx', import.meta.url), 'utf8'));
  assert.match(page, /const guestFeed = useGuestFeed\(\{ areas, enabled: interests !== null \}\);/);

  const hook = stripComments(readFileSync(new URL('./useGuestFeed.js', import.meta.url), 'utf8'));
  assert.match(hook, /export function useGuestFeed\(\{ areas = \[\], enabled = true \} = \{\}\)/);
  assert.match(hook, /const decision = guestFeedLoadDecision\(\{ enabled, previousKey, planKey: plan\.key \}\);\s*if \(!decision\) return undefined;/);
  assert.match(hook, /load\(plan, decision\.refresh \? \{ refresh: true, forceRefresh: false \} : \{\}\);/);
});
