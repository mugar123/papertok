import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/** SOURCE tests for C2: the history page loads with patience and never paints a cached absence. */

const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const read = async (path) => stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));

test('the first page goes through patientRead and the authority check, and aborts on cleanup', async () => {
  const jsx = await read('./MyCommentsPage.jsx');
  assert.match(jsx, /from '\.\/myCommentsLoad\.js'/);
  const effect = jsx.match(/patientRead\(\(\) => fetchMyCommentsPage\(\)\.then\(authoritativePage\)[\s\S]*?controller\.abort\(\);/);
  assert.ok(effect, 'the load is a patientRead over fetchMyCommentsPage().then(authoritativePage)');
  assert.match(effect[0], /onSlow:/);
  assert.match(effect[0], /onLateResult: apply/);
  assert.match(effect[0], /isReadTimeout\(error\)/);
});

test('the waits have words, and only ready can be empty', async () => {
  const jsx = await read('./MyCommentsPage.jsx');
  assert.match(jsx, /const WAITING_COPY = \{[\s\S]*?slow:[\s\S]*?offline:[\s\S]*?stalled:[\s\S]*?error:[\s\S]*?\};/);
  assert.match(jsx, /WAITING_COPY\[state\.status\] && \(/);
  assert.match(jsx, /state\.status === 'ready' && state\.rows\.length === 0 && \(/);
  assert.doesNotMatch(jsx, /state\.status === 'error' && \(/, 'the old error-only block is folded into the waits');
});

test('load more also refuses a cached absence', async () => {
  const jsx = await read('./MyCommentsPage.jsx');
  assert.match(jsx, /fetchMyCommentsPage\(\{ cursor: state\.cursor \}\)\.then\(authoritativePage\)/);
});

test('the wait has to have waited: onSlow goes through the elapsed-time gate', async () => {
  const jsx = await read('./MyCommentsPage.jsx');
  assert.match(jsx, /import \{[^}]*slowNoticeStatus[^}]*\} from '\.\.\/\.\.\/utils\/boundedRead\.js';/);
  assert.match(jsx, /const startedAt = Date\.now\(\);/, 'the effect stamps when the read began');
  const effect = jsx.match(/patientRead\(\(\) => fetchMyCommentsPage\(\)\.then\(authoritativePage\)[\s\S]*?controller\.abort\(\);/);
  const onSlow = effect[0].match(/onSlow: [\s\S]*?onLateResult:/);
  assert.ok(onSlow, 'onSlow still comes before onLateResult');
  assert.match(
    onSlow[0],
    /slowNoticeStatus\(Date\.now\(\) - startedAt, info\)/,
    'an unconfirmed absence rejects in about half a millisecond, and onSlow fires on it: '
    + 'without the gate the skeleton became "this is taking longer than usual" at 2 ms.',
  );
  assert.match(onSlow[0], /status: waited/, 'the gate hands back slow | offline, and both have copy');
  assert.doesNotMatch(
    onSlow[0],
    /info\?\.offline \? 'offline' : 'slow'/,
    'the offline decision belongs to the gate now, which exempts it from the wait',
  );
});
