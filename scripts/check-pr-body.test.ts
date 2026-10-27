import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prBodyProblems } from './check-pr-body.ts';

test('the unfilled template is rejected for all required sections', () => {
  const template = readFileSync(new URL('../.github/pull_request_template.md', import.meta.url), 'utf8');
  assert.deepEqual(prBodyProblems(template), [
    '"## Documentation" must state "Updated: <documents and changes>" or "Not needed: <reason>". See ARCHITECTURE.md for documentation owners.',
    '"## Verification" is empty. State what was actually run or done, not what was planned.',
    '"## Review" is empty. State what was actually run or done, not what was planned.',
  ]);
});

test('a description that reports checks and a reviewer passes', () => {
  const body = [
    '## Change', 'Feed pages show every paper they ask for.',
    '## Documentation', 'Updated: worker/README.md describes pagination.',
    '## Verification', '| Check or interaction | Result and evidence |', '| --- | --- |', '| `npm run check` | passed at 3562869a |',
    '## Review', 'Fresh-context reviewer subagent: no findings.',
  ].join('\n');
  assert.deepEqual(prBodyProblems(body), []);
});

test('missing sections are named', () => {
  assert.deepEqual(prBodyProblems('## What changes\nA fix.'), [
    'The description has no "## Documentation" section.',
    'The description has no "## Verification" section.',
    'The description has no "## Review" section.',
  ]);
});

test('a section ends at the next heading, so a later section cannot fill an empty one', () => {
  assert.deepEqual(prBodyProblems('## Documentation\nNot needed: only an internal name changed.\n## Verification\n\n## Review\nSamuel reviewed the Worker changes.\n## Limits\nNot deployed.'), [
    '"## Verification" is empty. State what was actually run or done, not what was planned.',
  ]);
});

test('documentation needs an explicit update or no-impact explanation in its own section', () => {
  const rest = '\n## Verification\nNode tests passed.\n## Review\nFresh context: no findings.';
  for (const documentation of [
    'Updated: ARCHITECTURE.md now describes the corpus.',
    'Not needed: an internal rename preserves the documented API.',
  ]) assert.deepEqual(prBodyProblems(`## Documentation\n${documentation}${rest}`), []);
  for (const documentation of [
    '',
    '<!-- Updated: describe changes here. -->',
    'Updated: ',
    'The docs are fine.',
    '## Other section\nNot needed: only a test changed.',
  ]) assert.equal(prBodyProblems(`## Documentation\n${documentation}${rest}`).length, 1);
});
