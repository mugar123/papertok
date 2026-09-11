import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

function bounded(code, from, to, label, maxLines) {
  const start = code.indexOf(from);
  const end = code.indexOf(to, start + 1);
  assert.ok(start >= 0 && end > start, `expected to have found ${label}`);
  const block = code.slice(start, end);
  const lines = block.split('\n').length;
  assert.ok(lines <= maxLines, `${label} capture spans ${lines} lines, past what it names`);
  return block;
}

/**
 * SOURCE: markNotInterested used to open with `if (!userId) return;`, so a
 * guest pressing Skip got a silent no-op — the card never left `papers`
 * (task 3, 2026-09-11). The fix drops the early return; only the Firestore
 * write stays behind `if (userId)`.
 *
 * Checking for the literal `if (!userId) return;` string alone has a blind
 * spot: a mutant that instead wraps the whole untouched local-state block in
 * a fresh `if (userId) { ... }` reintroduces the identical silent no-op for
 * guests, yet contains no `if (!userId) return;` substring anywhere — so
 * that check alone still passes it. What actually matters is where the
 * local-state calls sit relative to `if (IS_DEMO)`, the point where the
 * function forks into its demo/persisted paths, and whether any userId
 * conditional — of either polarity — stands before that fork at all.
 */
test('SOURCE: markNotInterested quita el paper también sin sesión', async () => {
  const code = stripComments(await read('./FeedContext.jsx'));
  const body = bounded(
    code,
    'const markNotInterested = useCallback(',
    '}, [withInteractionId, reRankFeed, recordProfileEvent, user?.uid, papers]);',
    'markNotInterested',
    50,
  );

  const demoAt = body.indexOf('if (IS_DEMO)');
  assert.ok(demoAt > 0, 'expected the demo/persisted fork inside markNotInterested');

  // The three calls the brief requires to run for every reader, guest or
  // not, must sit ahead of the fork.
  const setNotInterestedAt = body.indexOf('setNotInterestedIds(');
  const setPapersAt = body.indexOf('setPapers(');
  const reRankAt = body.indexOf('reRankFeed(successorId');
  assert.ok(setNotInterestedAt >= 0 && setNotInterestedAt < demoAt, 'the id lands in notInterestedIds ahead of the fork');
  assert.ok(setPapersAt >= 0 && setPapersAt < demoAt, 'the card leaves the feed ahead of the fork');
  assert.ok(reRankAt >= 0 && reRankAt < demoAt, 'the re-rank runs ahead of the fork');

  // Sitting ahead of the fork is not enough by itself — a mutant can wrap
  // that entire prelude in `if (userId) { ... }` and every index above still
  // holds unchanged. So the prelude itself must carry no userId
  // conditional, of either polarity: that is the one thing such a mutant
  // adds.
  const prelude = body.slice(0, demoAt);
  assert.doesNotMatch(
    prelude,
    /if\s*\(\s*!?userId\s*\)/,
    'no userId gate, of either polarity, stands before the local-state calls',
  );

  // The write that actually needs a session — the Firestore doc — stays
  // behind the gate, after the fork.
  assert.match(
    body.slice(demoAt),
    /else if \(userId\) \{[\s\S]*?(setDoc|updateDoc|writeInteraction)/,
    'the Firestore write stays behind the gate, after the fork',
  );
});
