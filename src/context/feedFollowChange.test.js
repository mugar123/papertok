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
 * SOURCE tests: FeedContext is a React context this repo cannot mount under
 * node. They pin what a follow change may do to the list on screen.
 *
 * Entering a paper's project from the feed, following it, unfollowing it and
 * coming back used to land on a different paper at the same index
 * (2026-09-07): the following effect replaced the whole list with a fresh
 * page — which never holds the card the reader is on, every painted paper
 * being in the seen set — and did so off the feed route, twice.
 */
test('SOURCE: a reset asked to keep the visible card merges the fresh page below it', async () => {
  const code = stripComments(await read('./FeedContext.jsx'));
  assert.match(code, /import \{ mergeFreshFeedPage, splitFeedForReRank \} from '\.\.\/utils\/feedReRankSplit\.js';/);
  assert.match(
    code,
    /const loadPapers = useCallback\(async \(reset = false, mode, randomizeStart = false, pageOverride, \{ keepThroughVisible = false \} = \{\}\) => \{/,
    'the option is an explicit parameter, not a ref the effect has to set',
  );
  const resetBranch = bounded(code, 'let nextPapers;', 'const nextHasMore =', 'the reset branch of loadPapers', 20);
  assert.match(
    resetBranch,
    /if \(reset\) \{\s*nextPapers = keepThroughVisible\s*\?\s*mergeFreshFeedPage\(papers, filtered, \{\s*anchorPaperIds: \[visiblePaperIdRef\.current\],?\s*\}\)\s*:\s*filtered;/,
    'through the visible card the list stays; the fresh page follows',
  );
});

test('SOURCE: the automatic retry after a failed reset keeps the option', async () => {
  const code = stripComments(await read('./FeedContext.jsx'));
  const retry = bounded(code, 'if (reset && !autoRetryUsedRef.current) {', '}, 2500);', 'the automatic retry', 8);
  assert.match(retry, /loadPapersRef\.current\?\.\(true, activeMode, false, undefined, \{ keepThroughVisible \}\);/);
});

test('SOURCE: the following effect records nothing off the feed route and compares against the last applied signature', async () => {
  const code = stripComments(await read('./FeedContext.jsx'));
  const effect = bounded(
    code,
    'const followingSignatureRef = useRef(null);',
    '}, [feedRouteActive, followedEntities, followingLoading',
    'the following effect',
    46,
  );
  const signatureAt = effect.indexOf("const signature = followedEntities");
  const gateAt = effect.indexOf('if (!feedRouteActive) return;');
  const compareAt = effect.indexOf('if (followingSignatureRef.current === signature) return;');
  const recordAt = effect.indexOf('followingSignatureRef.current = signature;');
  const appliedRecordAt = effect.search(/followingSignatureRef\.current = signature;\s*reRankFeed\(\);/);
  assert.ok(signatureAt >= 0 && gateAt >= 0 && compareAt >= 0 && recordAt >= 0 && appliedRecordAt >= 0, 'the five steps are there');
  assert.ok(gateAt > signatureAt, 'the signature is computed first (the topic warm-up above it stays unconditional)');
  assert.ok(gateAt < compareAt && gateAt < recordAt && gateAt < appliedRecordAt, 'off the feed route nothing is compared nor recorded: a follow and its undo cost nothing');
  assert.match(
    effect,
    /setTimeout\(\s*\(\) => loadPapers\(true, null, true, undefined, \{ keepThroughVisible: true \}\),\s*0,?\s*\)/,
    'the refresh keeps the reader on their card',
  );
  assert.match(effect, /reRankFeed\(\);/, 'the visible cards are still re-ranked, anchored, before the fresh page arrives');
});

test('SOURCE: the topic warm-up still runs before the gate, so the prewarm test keeps its 12-line window', async () => {
  const code = stripComments(await read('./FeedContext.jsx'));
  const head = bounded(code, 'const followingSignatureRef = useRef(null);', 'const signature = followedEntities', 'the head of the effect', 12);
  assert.match(head, /void loadTopicRetrieval\(\);/);
  assert.doesNotMatch(head, /feedRouteActive/, 'the gate comes after the signature, not before the warm-up');
});

/**
 * The tree no longer remounts when the uid arrives (src/utils/accountScope.js
 * adopts the first account at the same generation), so this effect used to run
 * once with `user` null and `followedEntities` empty, record '' as its baseline,
 * and then read the account's real follows landing as a follow CHANGE — a
 * re-rank and, with the recommendation profile ready, a cache wipe and a
 * replacing reload, on every signed-in cold load of '/'. FollowingContext and
 * EmailNotificationsContext were given a gate for the account arriving late;
 * this effect's ref was not. A signed-out reader has no follows to compare,
 * so waiting for the account loses nothing.
 */
test('SOURCE: the following baseline is recorded only under a known account', async () => {
  const code = stripComments(await read('./FeedContext.jsx'));
  const effect = bounded(
    code,
    'const followingSignatureRef = useRef(null);',
    '}, [feedRouteActive, followedEntities, followingLoading',
    'the following effect',
    46,
  );
  const guardAt = effect.search(/if \(!user\?\.uid\) \{\s*followingSignatureRef\.current = null;\s*return;\s*\}/);
  const compareAt = effect.indexOf('if (followingSignatureRef.current === signature) return;');
  assert.ok(guardAt >= 0, 'no account, no baseline: the ref is cleared and nothing is compared');
  assert.ok(guardAt < compareAt, 'decided before anything is compared or recorded');
  assert.match(
    code,
    /\}, \[feedRouteActive, followedEntities, followingLoading, isKnownPaper, loadPapers, reRankFeed, recommendationProfileReady, user\?\.uid\]\);/,
    'the account is a dependency, so the uid arriving re-runs the effect',
  );
});

/**
 * A grant code is not unique across funders — `grantID=100010` is three
 * distinct projects — so a project's `canonicalId`, which is a bare code for
 * everything followed before the OpenAIRE id landed, needs the funder stored
 * beside it to resolve to one project. Without it the feed served the mixed
 * 51-row set for a project whose own page correctly shows 39. Older follow
 * documents carry no funder at all, and for those the request has to stay
 * exactly what it was.
 */
test('SOURCE: a project follow asks OpenAIRE with the funder stored on it', async () => {
  const code = stripComments(await read('./FeedContext.jsx'));
  assert.match(
    code,
    /getPapersByProject\(follow\.canonicalId, 1, \{ funder: follow\.metadata\?\.funder \|\| '' \}\)/,
    'the funder rides along, and an absent one is the empty string this call already defaulted to',
  );
});
