import assert from 'node:assert/strict';
import test from 'node:test';
import { conferenceMembership, conferenceSortKey } from './conference-membership.ts';

// Synthetic OpenReview API2 submission.
const accepted = {
  id: 'exampleForum', forum: 'exampleForum',
  content: { venueid: { value: 'NeurIPS.cc/2026/Conference' }, venue: { value: 'NeurIPS 2026 Oral' } },
};

test('only the exact accepted venue and original forum confirm membership', () => {
  assert.deepEqual(conferenceMembership('neurips-2026', accepted), {
    editionId: 'neurips-2026', forumId: 'exampleForum', venueId: 'NeurIPS.cc/2026/Conference',
    venueText: 'NeurIPS 2026 Oral', track: 'oral',
  });
  assert.equal(conferenceMembership('iclr-2026', accepted), null);
  assert.equal(conferenceMembership('neurips-2026', { ...accepted, id: 'reply' }), null);
  for (const suffix of ['Rejected', 'Withdrawn', 'Submission', 'Workshop']) {
    assert.equal(conferenceMembership('neurips-2026', {
      ...accepted,
      content: { ...accepted.content, venueid: { value: 'NeurIPS.cc/2026/Conference/' + suffix } },
    }), null);
  }
  assert.equal(conferenceMembership('neurips-2026', {
    ...accepted, content: { ...accepted.content, venue: { value: 'NeurIPS 2026' } },
  })?.track, null);
});

test('the fixed order puts unknown presentation types after posters', async () => {
  const tracks = await Promise.all([
    conferenceSortKey('neurips-2026', 'one', 'poster'),
    conferenceSortKey('neurips-2026', 'two', null),
    conferenceSortKey('neurips-2026', 'three', 'oral'),
    conferenceSortKey('neurips-2026', 'four', 'spotlight'),
  ]);
  assert.deepEqual([...tracks].sort().map(key => tracks.indexOf(key)), [2, 3, 0, 1]);
  assert.equal(tracks[0], await conferenceSortKey('neurips-2026', 'one', 'poster'));
  assert.match(tracks[0], /^2[a-f0-9]{64}$/);
});
