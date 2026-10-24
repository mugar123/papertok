import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prBodyProblems } from './check-pr-body.ts';

test('the unfilled template is rejected for both sections', () => {
  const template = readFileSync(new URL('../.github/pull_request_template.md', import.meta.url), 'utf8');
  assert.deepEqual(prBodyProblems(template), [
    '"## Verification" is empty. State what was actually run or done, not what was planned.',
    '"## Review" is empty. State what was actually run or done, not what was planned.',
  ]);
});

test('a description that reports checks and a reviewer passes', () => {
  const body = [
    '## Change', 'Feed pages show every paper they ask for.',
    '## Verification', '| Check or interaction | Result and evidence |', '| --- | --- |', '| `npm run check` | passed at 3562869a |',
    '## Review', 'Fresh-context reviewer subagent: no findings.',
  ].join('\n');
  assert.deepEqual(prBodyProblems(body), []);
});

test('missing sections are named', () => {
  assert.deepEqual(prBodyProblems('## What changes\nA fix.'), [
    'The description has no "## Verification" section.',
    'The description has no "## Review" section.',
  ]);
});

test('a section ends at the next heading, so a later section cannot fill an empty one', () => {
  assert.deepEqual(prBodyProblems('## Verification\n\n## Review\nSamuel reviewed the Worker changes.\n## Limits\nNot deployed.'), [
    '"## Verification" is empty. State what was actually run or done, not what was planned.',
  ]);
});
