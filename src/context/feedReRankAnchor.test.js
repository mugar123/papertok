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
 * node. They pin the contract of the re-rank anchor.
 *
 * A reload puts the reader back on the card they left. The profile load then
 * re-ranks with no source paper, and the old split at index 0 shuffled that
 * very card away 1–3 s after the reload (2026-09-04). The re-rank must lock
 * through the visible card, whatever paper the interaction names.
 */
test('SOURCE: the re-rank splits through the deepest of the interacted and the visible paper', async () => {
  const code = stripComments(await read('./FeedContext.jsx'));
  assert.match(code, /import \{ splitFeedForReRank \} from '\.\.\/utils\/feedReRankSplit\.js';/);
  const rerank = bounded(code, 'const reRankFeed = useCallback(', '}, [calculateAndAttachScore]);', 'reRankFeed', 30);
  assert.match(rerank, /splitFeedForReRank\(prevPapers, \{\s*anchorPaperIds: \[sourcePaperId, visiblePaperIdRef\.current\],?\s*\}\)/,
    'both anchors go in, the split picks the deepest');
  assert.doesNotMatch(rerank, /splitIndex \+ 3|idx \+ 3/, 'the hand-rolled split at the top is gone');
  assert.match(rerank, /initialPapers: locked/, 'the shuffle diversifies against what stays locked');
  assert.match(rerank, /return \[\.\.\.locked, \.\.\.newQueue\];/);
});

test('SOURCE: the visible paper lives in a ref and is reported through the context value', async () => {
  const code = stripComments(await read('./FeedContext.jsx'));
  assert.match(code, /const visiblePaperIdRef = useRef\(null\);/);
  const report = bounded(code, 'const reportVisiblePaper = useCallback(', '}, []);', 'reportVisiblePaper', 6);
  assert.match(report, /visiblePaperIdRef\.current = paperId \|\| null;/, 'a ref write, never a state update');
  const value = bounded(code, 'const value = useMemo(() => ({', '}), [', 'the context value', 16);
  assert.match(value, /reportVisiblePaper/, 'consumers can report the card they are on');
});
