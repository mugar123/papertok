import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const CI = new URL('../../.github/workflows/ci.yml', import.meta.url);
const PACKAGE = new URL('../../package.json', import.meta.url);

// A YAML comment runs from an unquoted `#` to the end of the line. The SHA
// pins carry their tag in one (`# v4`), which is exactly the kind of text a
// regex over the raw file would be satisfied by.
const stripYamlComments = (source) => source.replace(/(^|\s)#.*$/gm, '');

// The block of one job: from `  <name>:` to the next line indented by two
// spaces or none (the next job, or a top-level key).
function job(yaml, name) {
  const header = `\n  ${name}:\n`;
  const start = yaml.indexOf(header);
  assert.ok(start >= 0, `job "${name}" is missing`);
  const body = yaml.slice(start + header.length);
  const next = body.search(/^( {2})?\S/m);
  return next >= 0 ? body.slice(0, next) : body;
}

/**
 * SOURCE tests over the workflow. Until 2026-09-10 the only workflow ran on a
 * push to main and never ran the rules suite; production (Vercel) runs no
 * tests at all. These pin what a PR has to pass.
 */
test('SOURCE: CI runs on pull requests and on pushes to main, with read-only permissions', async () => {
  const yaml = stripYamlComments(await readFile(CI, 'utf8'));
  assert.match(yaml, /^on:\n {2}pull_request:\n {2}push:\n {4}branches: \['main'\]\n/m, 'triggers: every PR, and main');
  assert.match(yaml, /^permissions:\n {2}contents: read\n/m, 'the token can read the repo and nothing else');
  assert.match(yaml, /^concurrency:\n {2}group: ci-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: true\n/m, 'a new push to the same ref cancels the run in flight');
});

test('SOURCE: every action is pinned to a commit', async () => {
  const yaml = stripYamlComments(await readFile(CI, 'utf8'));
  const uses = [...yaml.matchAll(/uses: (\S+)/g)].map(m => m[1]);
  assert.ok(uses.length >= 6, `expected checkout, setup-node, setup-java and cache steps, found ${uses.length} uses`);
  for (const ref of uses) {
    assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${ref} is not pinned to a 40-hex commit`);
  }
});

test('SOURCE: the check job is deploy.yml\'s Verify plus the build, on Node 22, with the same repository variables', async () => {
  const yaml = stripYamlComments(await readFile(CI, 'utf8'));
  const check = job(yaml, 'check');
  assert.match(check, /node-version: '22'/, 'CI is Node 22 (local is newer; the gap is real)');
  assert.match(check, /run: npm ci\n/, 'a clean install from the lockfile');
  assert.match(check, /run: npm run check\n/, 'one script, the same one a developer runs');
  for (const name of ['VITE_REPORT_API_URL', 'VITE_PAPER_API_BASE_URL', 'VITE_SCOPUS_ENABLED', 'VITE_UNPAYWALL_EMAIL']) {
    assert.match(check, new RegExp(`${name}: \\$\\{\\{ vars\\.${name} \\}\\}`), `${name} comes from the repository variables, as in deploy.yml`);
  }
  assert.doesNotMatch(check, /NODE_ENV/, 'NODE_ENV=production would reach lint and the tests too; vite build is production on its own');

  // `npm run check` must not be weaker than what deploy.yml verifies.
  const pkg = JSON.parse(await readFile(PACKAGE, 'utf8'));
  for (const script of ['security:secrets', 'lint', 'test', 'build', 'worker:deploy:dry-run']) {
    assert.ok(pkg.scripts.check.includes(script), `npm run check no longer runs ${script}`);
  }
});

test('SOURCE: the rules job runs the Firestore suite against the emulator on a pinned JDK and firebase-tools', async () => {
  const yaml = stripYamlComments(await readFile(CI, 'utf8'));
  const rules = job(yaml, 'rules');
  assert.match(rules, /timeout-minutes: 15/, 'the emulator cannot hang the runner for six hours');
  assert.match(rules, /uses: actions\/setup-java@cf277c60eb25467037889841efdb72551f06f6c3\n\s+with:\n\s+distribution: 'temurin'\n\s+java-version: '21'\n/,
    'the Firestore emulator is a Java program');
  assert.match(rules, /path: ~\/\.cache\/firebase\/emulators\n\s+key: firestore-emulator-\$\{\{ runner\.os \}\}-firebase-tools-15\.27\.0\n/,
    'the emulator jar is cached by the firebase-tools version that downloads it');
  assert.match(rules, /run: npm ci\n/, 'the suite imports src/ and @firebase/rules-unit-testing');
  assert.match(rules, /run: npm install -g firebase-tools@15\.27\.0\n/, 'the version verified locally, on the PATH, so npm run test:rules works unchanged');
  assert.match(rules, /run: npm run test:rules\n/, 'the same script a developer runs');
});

test('SOURCE: there is no second publish workflow, and nothing publishes to GitHub Pages', async () => {
  // This used to assert that `deploy.yml` was untouched. It was removed on
  // 2026-09-18: it published a build nothing could reach -- the only entrance,
  // `mugar123.github.io/papertok/`, 301s to `papertok.app`, which is Vercel --
  // and everything it ran (`security:secrets`, `lint`, `test`,
  // `worker:deploy:dry-run`) is a strict subset of the `npm run check` the CI
  // job above already runs on the same push.
  //
  // What replaces the old assertion is the shape of the claim, not the file:
  // production has one publisher, and it is not a workflow in this repository.
  // A second one reappearing is what this now catches.
  const { readdir } = await import('node:fs/promises');
  const dir = new URL('../../.github/workflows/', import.meta.url);
  const files = await readdir(dir);
  assert.deepEqual(files.sort(), ['ci.yml'], `unexpected workflow(s): ${files.join(', ')}`);

  // And the Pages site itself stays up on purpose: it is what redirects the
  // old origin to the new one, so an old link still lands somewhere. What was
  // retired is publishing to it, not the redirect.
  const worker = await readFile(new URL('../../worker/report-api.js', import.meta.url), 'utf8');
  assert.match(worker, /https:\/\/mugar123\.github\.io/, 'the old origin left the allowlist without anyone saying so');
});
