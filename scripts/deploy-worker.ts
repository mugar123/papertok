import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

// PaperTok > Default in PostHog EU. Maps uploaded to another project leave the
// Worker's error reports without source locations.
const projectId = '306340';
const posthogHost = 'https://eu.i.posthog.com';
// The log lines and file markers this script checks are those of this release.
// Any other version stops the deploy until the checks are verified against it.
const posthogCliVersion = 'posthog-cli 0.18.12';
const output = '.wrangler/posthog-worker';
const wranglerArgs = process.argv.slice(2);
const { env } = process;
const scriptExtensions = new Set(['.js', '.mjs', '.cjs']);

type CredentialSource = 'environment' | 'login';
type Exit = Pick<SpawnSyncReturns<unknown>, 'error' | 'signal' | 'status'>;

// Failures throw instead of calling process.exit, so output already written,
// such as the upload's log, reaches the console before the process ends.
class Stop extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

function fail(message: string, code = 1): never {
  throw new Stop(message, code);
}

const exitReason = (result: Exit) =>
  result.error?.message ?? (result.signal ? `signal ${result.signal}` : `exit code ${result.status}`);

// A failed step's exit code is passed on, so a failed wrangler deploy exits as wrangler did.
function stopAfter(step: string, result: Exit): never {
  fail(`${step} failed (${exitReason(result)}); no later step ran.`, result.status || 1);
}

function run(step: string, bin: string, args: readonly string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { stdio: 'inherit' });
  if (result.status !== 0) stopAfter(step, result);
}

// Anything other than unset, empty or "false" counts as on, so a doubtful value is refused.
const isOn = (value: string | undefined) => value !== undefined && value !== '' && value !== 'false';

// Step 0, before any process starts: which credentials posthog-cli has to use.
function credentialMode(): CredentialSource {
  if (isOn(env.POSTHOG_CLI_DRY_RUN)) {
    fail('unset POSTHOG_CLI_DRY_RUN: posthog-cli would skip the upload and the Worker would deploy without source maps.');
  }
  // posthog-cli also takes credentials from the legacy token and project names,
  // from a dotenv file, or from another login folder.
  const otherSources = ['POSTHOG_CLI_TOKEN', 'POSTHOG_CLI_ENV_ID', 'POSTHOG_CLI_DOTENV_FILE', 'POSTHOG_HOME']
    .filter((name) => env[name] !== undefined);
  if (otherSources.length > 0) {
    fail(`unset ${otherSources.join(', ')}: PostHog credentials come only from POSTHOG_CLI_API_KEY and POSTHOG_CLI_PROJECT_ID, or from posthog-cli login.`);
  }
  // A variable set to an empty value counts as set. posthog-cli takes the
  // environment only when both variables are set, empty or not, and otherwise
  // uses the login, which someone who set one of them did not ask for.
  const expected: CredentialSource =
    env.POSTHOG_CLI_API_KEY !== undefined || env.POSTHOG_CLI_PROJECT_ID !== undefined || isOn(env.CI)
      ? 'environment'
      : 'login';
  if (expected === 'environment' && (!env.POSTHOG_CLI_API_KEY || env.POSTHOG_CLI_PROJECT_ID !== projectId)) {
    fail(`set POSTHOG_CLI_API_KEY and POSTHOG_CLI_PROJECT_ID=${projectId}. In CI, or once either variable is set, even to an empty value, the posthog-cli login is not used.`);
  }
  return expected;
}

function binPath(manifestPath: string, name: string): string {
  const { bin } = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: Record<string, string> };
  const entry = bin?.[name];
  if (!entry) fail(`${manifestPath} declares no "${name}" bin.`);
  return join(dirname(manifestPath), entry);
}

// `--version` is answered by the argument parser, which exits before posthog-cli
// loads credentials or runs a command.
function checkCliVersion(posthogCli: string) {
  const result = spawnSync(process.execPath, [posthogCli, '--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const printed = (result.stdout ?? '').replace(/\r?\n$/, '');
  if (result.status === 0 && printed === posthogCliVersion) return;
  const found = /^posthog-cli \S+$/.test(printed) ? printed : `no version (${exitReason(result)})`;
  fail(`expected ${posthogCliVersion}, found ${found}. The checks in scripts/deploy-worker.ts read that version's output; verify them against the installed version before changing posthogCliVersion. Nothing was built or deployed.`);
}

function describeSource(source: CredentialSource, project: string) {
  const credentials = source === 'login' ? 'the posthog-cli login' : 'POSTHOG_CLI_API_KEY and POSTHOG_CLI_PROJECT_ID';
  return `${credentials} for project ${/^\d+$/.test(project) ? project : '(unrecognised)'}`;
}

// Step 1, the credential check. It uploads nothing and is separate from the
// upload of the Worker's maps in step 6. On an empty folder, `sourcemap upload`
// loads its credentials, logs their source and project at debug level, finds no
// file and returns before it resolves a release or calls the PostHog API. Only
// that log target is enabled and none of its output is printed; a missing line
// or a line in another format stops the deploy.
// `posthog-cli api call --json project-get` would name the project too, but in
// 0.18.12 it first reads GET /api/users/@me/, which needs the user:read scope
// that `posthog-cli login` does not grant, so it exits 1 with "missing scope
// user:read". The check reads the auth log line instead of adding that scope.
function checkCredentials(posthogCli: string, expected: CredentialSource) {
  const emptyDirectory = mkdtempSync(join(tmpdir(), 'papertok-posthog-check-'));
  const check = spawnSync(
    process.execPath,
    [posthogCli, '--host', posthogHost, 'sourcemap', 'upload', '--directory', emptyDirectory],
    { encoding: 'utf8', env: { ...env, RUST_LOG: 'posthog_cli::utils::auth=debug' }, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  rmSync(emptyDirectory, { recursive: true, force: true });
  const used = stripVTControlCharacters(check.stderr ?? '').split(/\r?\n/).flatMap((line) => {
    const match = /Using token from(?: (environment) or --dotenv-file|: .+), for environment (.*)$/.exec(line);
    if (!match) return [];
    const source: CredentialSource = match[1] ? 'environment' : 'login';
    return [{ source, project: match[2] }];
  });
  if (check.status === 0 && used.length === 1 && used[0].source === expected && used[0].project === projectId) return;
  const found = used.length === 1 ? describeSource(used[0].source, used[0].project)
    : used.length === 0 ? 'no credential source in its log' : 'more than one credential source';
  const exit = check.status === 0 ? '' : `, and posthog-cli failed (${exitReason(check)})`;
  const action = expected === 'login' ? `Run \`npx posthog-cli login\` with access to project ${projectId}.` : 'Check POSTHOG_CLI_API_KEY.';
  fail(`PostHog credential check expected ${describeSource(expected, projectId)}, found ${found}${exit}. ${action} Nothing was built or deployed.`);
}

const sourceMaps = (command: string, release: string) => [
  '--host', posthogHost, 'sourcemap', command, '--directory', output,
  '--release-name', 'papertok-worker', '--release-version', release,
];

// posthog-cli pairs a script with the map its last sourceMappingURL comment
// names, or else with <script>.map, and skips a script whose reference does not decode.
function mapOf(script: string, text: string): string | undefined {
  const reference = text.split(/\r?\n/).reverse().map((line) => line.trim())
    .find((line) => line.startsWith('//# sourceMappingURL=') || line.startsWith('//@ sourceMappingURL='));
  const candidates = [`${script}.map`];
  if (reference !== undefined) {
    try {
      candidates.unshift(resolve(dirname(script), decodeURIComponent(reference.slice('//# sourceMappingURL='.length))));
    } catch {
      return undefined;
    }
  }
  return candidates.find((path) => existsSync(path));
}

// The script's own `//# chunkId=` line is the id posthog-cli uploads it under.
const scriptChunkId = (text: string) =>
  text.split(/\r?\n/).reverse().find((line) => line.startsWith('//# chunkId='))?.slice('//# chunkId='.length);

function mapChunkId(map: string): unknown {
  try {
    const content = JSON.parse(readFileSync(map, 'utf8')) as { chunk_id?: unknown; chunkId?: unknown };
    return content.chunk_id ?? content.chunkId;
  } catch {
    return undefined;
  }
}

// Step 5. Upload sends only scripts that carry a chunk id and exits 0 when none
// does. Inject writes the same id into a script (a `//# chunkId=` line) and its
// map (`chunk_id`), so every script in the bundle folder must have a map with
// its id, and every map a script.
function countInjectedPairs(): number {
  const name = (path: string) => relative(process.cwd(), path);
  const files = readdirSync(output, { recursive: true, encoding: 'utf8' })
    .map((file) => resolve(output, file))
    .filter((path) => statSync(path).isFile());
  const unclaimedMaps = new Set(files.filter((path) => path.endsWith('.map')));
  const entry = resolve(output, 'instrumentation.js');
  let pairs = 0;
  let entryPaired = false;
  for (const script of files.filter((path) => scriptExtensions.has(extname(path)))) {
    const text = readFileSync(script, 'utf8');
    const map = mapOf(script, text);
    if (map === undefined) fail(`${name(script)} has no source map; nothing was uploaded or deployed.`);
    const id = scriptChunkId(text);
    if (!id || id !== mapChunkId(map)) {
      fail(`${name(script)} and ${name(map)} do not carry the same PostHog chunk id; nothing was uploaded or deployed.`);
    }
    unclaimedMaps.delete(resolve(map));
    pairs += 1;
    if (script === entry) entryPaired = true;
  }
  const [orphan] = unclaimedMaps;
  if (orphan !== undefined) fail(`${name(orphan)} is the source map of no script in ${output}; nothing was uploaded or deployed.`);
  if (pairs === 0) fail(`${output} holds no script with its source map; nothing was uploaded or deployed.`);
  if (!entryPaired) fail(`${name(entry)} has no injected source map; nothing was uploaded or deployed.`);
  return pairs;
}

const numbersIn = (lines: readonly string[], pattern: RegExp) => lines.flatMap((line) => {
  const match = pattern.exec(line);
  return match ? [match.slice(1).map(Number)] : [];
});

// The upload exits 0 in cases that leave maps out of PostHog, so its log has to
// account for every pair counted in step 5:
// - before any request it logs "Found N chunks to upload" for the pairs it
//   selected, or "nothing to upload" when it selected none;
// - after its requests it logs "Upload summary: X chunk(s) uploaded, Y skipped
//   (Z already present, W too large)". X + Z falls short when a chunk is too
//   large or its map is empty, and the npm launcher exits 0 when the binary is
//   killed by a signal, which leaves no summary.
function uploadLogProblem(log: string, pairs: number): string | undefined {
  const lines = stripVTControlCharacters(log).split(/\r?\n/);
  if (lines.some((line) => line.endsWith('nothing to upload'))) return '"nothing to upload"';
  const found = numbersIn(lines, /\bFound (\d+) chunks to upload$/);
  if (found.length === 0) return 'no "Found N chunks to upload" line (RUST_LOG may hide it)';
  if (found.length > 1) return 'more than one chunk count';
  if (found[0][0] !== pairs) return `${found[0][0]} chunks to upload`;
  const summaries = numbersIn(lines, /\bUpload summary: (\d+) chunk\(s\) uploaded, \d+ skipped \((\d+) already present, (\d+) too large\)$/);
  if (summaries.length === 0) return 'no upload summary, as when it stops before its requests finish';
  if (summaries.length > 1) return 'more than one upload summary';
  const [uploaded, present, tooLarge] = summaries[0];
  if (uploaded + present !== pairs) {
    return `${uploaded} chunks uploaded, ${present} already present and ${tooLarge} too large`;
  }
  return undefined;
}

// Step 6, the real upload of the bundle's maps, separate from the credential
// check in step 1. Its log is passed through as it was written.
function uploadBundleMaps(posthogCli: string, release: string, pairs: number) {
  const result = spawnSync(process.execPath, [posthogCli, ...sourceMaps('upload', release)], {
    stdio: ['inherit', 'inherit', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  // stderr is null only when the process could not start.
  const log = result.stderr ?? Buffer.alloc(0);
  if (log.length > 0) process.stderr.write(log);
  if (result.status !== 0) stopAfter('posthog-cli sourcemap upload', result);
  const problem = uploadLogProblem(log.toString('utf8'), pairs);
  if (problem !== undefined) {
    fail(`posthog-cli sourcemap upload reported ${problem} for ${pairs} injected source map pairs; the Worker was not deployed.`);
  }
}

function deploy() {
  const expectedSource = credentialMode();

  // npm installs these tools as .cmd shims on Windows, which spawning without a
  // shell cannot run, so each package's own entry point, found from the
  // repository root npm runs this script in, runs with this Node.
  const require = createRequire(join(process.cwd(), 'package.json'));
  const wrangler = binPath(require.resolve('wrangler/package.json'), 'wrangler');
  const posthogCli = binPath(require.resolve('@posthog/cli/package.json'), 'posthog-cli');

  checkCliVersion(posthogCli);
  checkCredentials(posthogCli, expectedSource);

  // Step 2. The commit names the release the maps are uploaded under.
  const release = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  // Step 3. The chunk id written into the bundle is what links an error report
  // to its source map, so the deployed bundle has to be the injected one.
  // Without bundling, wrangler uploads every module in the folder, so it starts empty.
  rmSync(output, { recursive: true, force: true });
  run('wrangler deploy --dry-run', wrangler, ['deploy', '--dry-run', '--outdir', output, ...wranglerArgs]);
  // Step 4.
  run('posthog-cli sourcemap inject', posthogCli, sourceMaps('inject', release));
  const pairs = countInjectedPairs();
  uploadBundleMaps(posthogCli, release, pairs);
  // Step 7.
  run('wrangler deploy', wrangler, ['deploy', `${output}/instrumentation.js`, '--no-bundle', '--config', 'wrangler.toml', ...wranglerArgs]);
}

try {
  deploy();
} catch (error) {
  if (!(error instanceof Stop)) throw error;
  console.error(`worker:deploy: ${error.message}`);
  process.exitCode = error.code;
}
