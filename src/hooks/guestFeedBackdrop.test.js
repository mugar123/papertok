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

test('stored guest choices never enable or mount a feed on the signed-out route', () => {
  const page = stripComments(readFileSync(new URL('../components/Public/GuestFeedPage.jsx', import.meta.url), 'utf8'));
  assert.doesNotMatch(page, /useGuestFeed|FeedContainer|firstVisit|guest_demo_start/);
  assert.match(page, /return \(\s*<GuestWelcome/);
  assert.match(page, /initialAreas=\{interests\?\.areas\}/);
  assert.match(page, /initialTopics=\{interests\?\.topics\}/);
  assert.match(page, /onComplete=\{requestAccount\}/);
  assert.match(page, /onSignIn=\{requestAccount\}/);
  assert.match(page, /if \(answer\?\.areas\) saveGuestInterests\(answer\);\s*onAuthRequired\?\.\('other'\);/);

  const app = stripComments(readFileSync(new URL('../App.jsx', import.meta.url), 'utf8'));
  const feedRoute = app.slice(app.indexOf('path="/feed"'), app.indexOf('path="/lists"'));
  assert.match(feedRoute, /authLoading \|\| user \? \(\s*<ProtectedRoute>/);
  assert.match(feedRoute, /<GuestFeedPage\s+onAuthRequired=\{requestAuthentication\}/);
});
