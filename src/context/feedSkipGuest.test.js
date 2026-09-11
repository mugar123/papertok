import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('SOURCE: markNotInterested quita el paper también sin sesión', async () => {
  const ctx = strip(await read('./FeedContext.jsx'));
  const start = ctx.indexOf('const markNotInterested = useCallback(');
  // Bounded to the function's own closing line. A fixed-length slice (the
  // brief's original +3000) bleeds into markAsRead right below, which keeps
  // its own legitimate `if (!userId) return;` — out of scope for this task
  // and not the guest gate this fix removes.
  const end = ctx.indexOf('}, [withInteractionId, reRankFeed, recordProfileEvent, user?.uid, papers]);', start);
  assert.ok(start >= 0 && end > start, 'expected to have found markNotInterested');
  const body = ctx.slice(start, end);
  assert.doesNotMatch(body, /if \(!userId\) return;/, 'la puerta de invitado ya no corta la parte local');
  assert.match(body, /if \(userId\) \{[\s\S]*?(setDoc|updateDoc|writeInteraction)/, 'la escritura queda tras la puerta');
});
