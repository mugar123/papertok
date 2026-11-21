import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const completeBody = '## Documentation\nNot needed: example.\n## Verification\nNode tests passed.\n## Review\nFresh-context review complete.';

test('a rules change with no Firestore release step is rejected, as in #535', () => {
  assert.deepEqual(prBodyProblems(`${completeBody}\n## Production\nVercel deploys the web on merge.`, [
    'firestore.rules', 'src/context/auth-context.tsx',
  ]), [
    'Changes to firestore.rules require this line in "## Production": Deploy Firestore rules before the web merge.',
  ]);
});

test('each changed Firestore file needs its own deployment statement in Production', () => {
  const rules = '- Deploy Firestore rules before the web merge.';
  const indexes = '- Deploy Firestore indexes before the web merge.';
  const files = ['firestore.rules', 'firestore.indexes.json'];
  assert.deepEqual(prBodyProblems(`${completeBody}\n## Production\n${rules}\n${indexes}`, files), []);
  assert.deepEqual(prBodyProblems(`${completeBody}\n## Production\n${rules}\n<!-- ${indexes} -->\n## Notes\n${indexes}`, files), [
    'Changes to firestore.indexes.json require this line in "## Production": Deploy Firestore indexes before the web merge.',
  ]);
  assert.equal(prBodyProblems(`${completeBody}\n## Production\n  ## Notes\n${rules}`, [files[0]]).length, 1);
  assert.equal(prBodyProblems(`${completeBody}\n## Production\n\n    ${rules}`, [files[0]]).length, 1);
  assert.deepEqual(prBodyProblems(`${completeBody}\n## Production\nDeploy Firestore indexes after the web merge.`, [files[1]]), [
    'Changes to firestore.indexes.json require this line in "## Production": Deploy Firestore indexes before the web merge.',
  ]);
  assert.deepEqual(prBodyProblems(completeBody, ['tests/firestore.rules.test.ts']), []);
});

test('a deployment statement inside a Markdown example does not satisfy the gate', () => {
  const body = `${completeBody}\n\`\`\`markdown\n## Production\nDeploy Firestore rules before the web merge.\n\`\`\``;
  assert.deepEqual(prBodyProblems(body, ['firestore.rules']), [
    'Changes to firestore.rules require this line in "## Production": Deploy Firestore rules before the web merge.',
  ]);
});

test('the workflow entry point detects a rename away from firestore.rules', () => {
  const directory = mkdtempSync(join(tmpdir(), 'papertok-pr-body-'));
  const event = join(directory, 'event.json');
  const files = join(directory, 'files.json');
  try {
    writeFileSync(event, JSON.stringify({ pull_request: { body: completeBody } }));
    writeFileSync(files, JSON.stringify([[{ filename: 'renamed.rules', previous_filename: 'firestore.rules' }]]));
    const script = fileURLToPath(new URL('./check-pr-body.ts', import.meta.url));
    const result = spawnSync(process.execPath, [script, files], {
      encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_PATH: event },
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Changes to firestore\.rules require this line/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
