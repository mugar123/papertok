import { execFileSync, spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

// PaperTok > Default in PostHog EU. Maps uploaded to another project leave the
// Worker's error reports without source locations.
const projectId = '306340';
const posthogHost = 'https://eu.i.posthog.com';
// The log lines and file markers this script checks are those of this release.
// Any other version stops the deploy until the checks are verified against it.
const posthogCliVersion = 'posthog-cli 0.18.12';
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

// posthog-cli's argument parser reads these variables and exits 2 before running
// its command when one is set to an empty value. An empty value means unset
// here, so the posthog-cli calls start without it (spawn leaves out a variable
// set to undefined). The wrangler calls inherit the environment unchanged.
const parsedVariables = ['POSTHOG_CLI_DRY_RUN', 'POSTHOG_CLIENT_RATE_LIMIT', 'POSTHOG_RELEASE_MODE', 'POSTHOG_CLI_SOURCEMAP_UPLOAD_CONCURRENCY'];
const posthogEnv: NodeJS.ProcessEnv = { ...env };
for (const name of parsedVariables) {
  if (env[name] === '') posthogEnv[name] = undefined;
}

// Before step 1, while no process has started: which credentials posthog-cli has to use.
function credentialMode(): CredentialSource {
  if (isOn(env.POSTHOG_CLI_DRY_RUN)) {
    fail('unset POSTHOG_CLI_DRY_RUN: only unset, empty or false is accepted.');
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

// Step 1. `--version` is answered by the argument parser, which exits before
// posthog-cli loads credentials or runs a command.
function checkCliVersion(posthogCli: string) {
  const result = spawnSync(process.execPath, [posthogCli, '--version'], { encoding: 'utf8', env: posthogEnv, stdio: ['ignore', 'pipe', 'inherit'] });
  const printed = (result.stdout ?? '').replace(/\r?\n$/, '');
  if (result.status === 0 && printed === posthogCliVersion) return;
  const found = /^posthog-cli \S+$/.test(printed) ? printed : `no version (${exitReason(result)})`;
  fail(`expected ${posthogCliVersion}, found ${found}. The checks in scripts/deploy-worker.ts read that version's output; verify them against the installed version before changing posthogCliVersion. Nothing was built or deployed.`);
}

function describeSource(source: CredentialSource, project: string) {
  const credentials = source === 'login' ? 'the posthog-cli login' : 'POSTHOG_CLI_API_KEY and POSTHOG_CLI_PROJECT_ID';
  return `${credentials} for project ${/^\d+$/.test(project) ? project : '(unrecognized)'}`;
}

// Each posthog-cli process loads its credentials once, before its command runs,
// and logs where from at debug level under this target. The login's line holds
// the path of the stored session, so these lines are never printed.
const isCredentialLine = (line: string) => line.includes('posthog_cli::utils::auth') || line.includes('Using token from');

function credentialsIn(line: string): { source: CredentialSource; project: string } | undefined {
  const match = /Using token from(?: (environment) or --dotenv-file|: .+), for environment (.*)$/.exec(line);
  return match ? { source: match[1] ? 'environment' : 'login', project: match[2] } : undefined;
}

// Step 2, the credential check. It uploads nothing and is separate from the
// upload of the Worker's maps in step 5. With --stdin and an input that is closed
// from the start, `sourcemap upload` loads its credentials, logs their source and
// project at debug level, reads no folder, logs "nothing to upload" and returns
// before it resolves a release or calls the PostHog API. Only the credential log
// target is enabled and none of its output is printed; a missing line or a line
// in another format stops the deploy.
// `posthog-cli api call --json project-get` would name the project too, but in
// 0.18.12 it first reads GET /api/users/@me/, which needs the user:read scope
// that `posthog-cli login` does not grant, so it exits 1 with "missing scope
// user:read". The check reads the auth log line instead of adding that scope.
function checkCredentials(posthogCli: string, expected: CredentialSource) {
  const check = spawnSync(
    process.execPath,
    [posthogCli, '--host', posthogHost, 'sourcemap', 'upload', '--stdin'],
    { encoding: 'utf8', env: { ...posthogEnv, RUST_LOG: 'posthog_cli::utils::auth=debug' }, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const used = stripVTControlCharacters(check.stderr ?? '').split(/\r?\n/).flatMap((line) => {
    const credentials = credentialsIn(line);
    return credentials ? [credentials] : [];
  });
  if (check.status === 0 && used.length === 1 && used[0].source === expected && used[0].project === projectId) return;
  const found = used.length === 1 ? describeSource(used[0].source, used[0].project)
    : used.length === 0 ? 'no credential source in its log' : 'more than one credential source';
  const exit = check.status === 0 ? '' : `, and posthog-cli failed (${exitReason(check)})`;
  // Exit code 2 before any credential line means the argument parser rejected a
  // value; with the arguments fixed, that points to one of these variables. Its
  // message can hold the value, so only the names of those set are given.
  const setParsed = parsedVariables.filter((name) => posthogEnv[name] !== undefined);
  const action = check.status === 2 && used.length === 0 && setParsed.length > 0
    ? `One of the PostHog variables posthog-cli parses as options holds a value it rejects; the ones set are ${setParsed.join(', ')}.`
    : expected === 'login' ? `Run \`npx posthog-cli login\` with access to project ${projectId}.` : 'Check POSTHOG_CLI_API_KEY.';
  fail(`PostHog credential check expected ${describeSource(expected, projectId)}, found ${found}${exit}. ${action} Nothing was built or deployed.`);
}

// Inject in step 3 and upload in step 5 run behind a gate, because the login
// can change after the credential check: inject resolves the release and upload
// sends the maps in whichever project the login names when that process starts.
// With --stdin and no --directory, posthog-cli 0.18.12 loads its credentials,
// logs where from, then reads the folders to work on from its input until it
// ends, and makes no request to the project those credentials name before that.
// The script writes the bundle folder only after that process has logged the
// expected source and project 306340. Otherwise it closes the input empty:
// inject then exits 1 with "no source files found", upload exits 0 with
// "nothing to upload", neither makes a request to that project, and the step
// fails. The process is never killed for a mismatch; a timeout kills it only
// after its input was closed. The explicit --release-mode keeps
// POSTHOG_RELEASE_MODE from changing it.
const sourceMaps = (command: string, release: string) => [
  '--host', posthogHost, 'sourcemap', command, '--stdin',
  '--release-name', 'papertok-worker', '--release-version', release, '--release-mode', 'event',
];
// Info lines for the upload checks, and the credential line for the gate,
// whatever RUST_LOG holds.
const gatedRustLog = 'info,posthog_cli::utils::auth=debug';
const credentialLineTimeoutMs = 20_000;
const exitAfterTimeoutMs = 15_000;

// Returns the lines of its log that it printed, which leave out the credential line.
async function runGated(command: 'inject' | 'upload', posthogCli: string, release: string, expected: CredentialSource, output: string) {
  const step = `posthog-cli sourcemap ${command}`;
  const child = spawn(process.execPath, [posthogCli, ...sourceMaps(command, release)], {
    env: { ...posthogEnv, RUST_LOG: gatedRustLog },
    stdio: ['pipe', 'inherit', 'pipe'],
  });
  const printed: string[] = [];
  let pending = '';
  // Set from the child's events; the assertion keeps TypeScript from narrowing it to 'waiting'.
  let gate = 'waiting' as 'waiting' | 'opened' | 'refused';
  let found = '';
  let laterCredentialLines = 0;
  let inputError: Error | undefined;
  let launcherExit: Exit | undefined;
  let killed = false;
  let credentialTimer: NodeJS.Timeout | undefined;
  let exitTimer: NodeJS.Timeout | undefined;

  // A refusal closes the input empty and leaves the process to exit by itself.
  const refuse = (reason: string) => {
    if (gate !== 'waiting') return;
    gate = 'refused';
    found = reason;
    clearTimeout(credentialTimer);
    child.stdin.end();
  };
  child.stdin.on('error', (error) => {
    inputError = error;
  });

  // Only complete lines are judged, so a credential line split across reads counts as a whole.
  const take = (chunk: string, ended: boolean) => {
    pending += chunk;
    const end = ended ? pending.length : pending.lastIndexOf('\n') + 1;
    const complete = pending.slice(0, end);
    pending = pending.slice(end);
    if (complete === '') return;
    const credentialLines: string[] = [];
    let text = '';
    for (const line of complete.split(/(?<=\n)/)) {
      const plain = stripVTControlCharacters(line).replace(/\r?\n$/, '');
      if (isCredentialLine(plain)) {
        credentialLines.push(plain);
      } else {
        text += line;
        printed.push(line);
      }
    }
    if (text !== '' && !process.stderr.write(text)) {
      child.stderr.pause();
      process.stderr.once('drain', () => child.stderr.resume());
    }
    if (credentialLines.length === 0) return;
    if (gate !== 'waiting') {
      laterCredentialLines += credentialLines.length;
      return;
    }
    const used = credentialLines.length === 1 ? credentialsIn(credentialLines[0]) : undefined;
    if (credentialLines.length > 1) refuse('more than one credential line');
    else if (!used) refuse('a credential line in another format');
    else if (used.source !== expected || used.project !== projectId) refuse(describeSource(used.source, used.project));
    else {
      gate = 'opened';
      clearTimeout(credentialTimer);
      child.stdin.end(`${resolve(output)}\n`);
    }
  };

  const result = await new Promise<Exit>((done) => {
    // Killing the npm launcher does not stop the binary it started, which can
    // keep the log pipe open, so after a kill the wait ends with the launcher.
    const stopWaiting = (exit: Exit) => {
      child.stderr.destroy();
      done(exit);
    };
    credentialTimer = setTimeout(() => {
      refuse(`no credential line within ${credentialLineTimeoutMs / 1000} s`);
      exitTimer = setTimeout(() => {
        killed = true;
        if (launcherExit) stopWaiting(launcherExit);
        else child.kill('SIGKILL');
      }, exitAfterTimeoutMs);
    }, credentialLineTimeoutMs);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => take(chunk, false));
    // A last line without a newline is printed or dropped, but cannot open the gate.
    child.stderr.on('end', () => {
      refuse('no credential line');
      take('', true);
    });
    child.on('error', (error) => done({ error, signal: null, status: null }));
    child.on('close', (status, signal) => done({ signal, status }));
    child.on('exit', (status, signal) => {
      launcherExit = { signal, status };
      refuse('no credential line');
      if (killed) stopWaiting(launcherExit);
    });
  });
  clearTimeout(credentialTimer);
  clearTimeout(exitTimer);
  refuse('no credential line');

  if (killed) {
    fail(`${step} logged no credential line within ${credentialLineTimeoutMs / 1000} s and did not exit within ${exitAfterTimeoutMs / 1000} s after its input was closed, so it was stopped. Its posthog-cli binary may still be running, without the bundle folder. The Worker was not deployed.`);
  }
  if (result.error) stopAfter(step, result);
  if (gate === 'refused') {
    fail(`${step} was not given the bundle folder: expected ${describeSource(expected, projectId)}, found ${found}. The Worker was not deployed.`);
  }
  if (result.status !== 0) stopAfter(step, result);
  if (laterCredentialLines > 0) fail(`${step} logged another credential line after it was given the bundle folder; the Worker was not deployed.`);
  if (inputError) fail(`${step} did not read the bundle folder from its input; the Worker was not deployed.`);
  return printed;
}

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

// Step 4. Upload sends only scripts that carry a chunk id and exits 0 when none
// does. Inject writes the same id into a script (a `//# chunkId=` line) and its
// map (`chunk_id`), so every script in the bundle folder must have a map with
// its id, and every map a script.
function countInjectedPairs(output: string): number {
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
// account for every pair counted in step 4:
// - before any request it logs "Found N chunks to upload" for the pairs it
//   selected, or "nothing to upload" when it selected none;
// - after its requests it logs "Upload summary: X chunk(s) uploaded, Y skipped
//   (Z already present, W too large)". X + Z falls short when a chunk is too
//   large or its map is empty, and the npm launcher exits 0 when the binary is
//   killed by a signal, which leaves no summary. A chunk already present counts:
//   its ID derives from its script's content, so PostHog holds a map for the same code.
function uploadLogProblem(log: string, pairs: number): string | undefined {
  const lines = stripVTControlCharacters(log).split(/\r?\n/);
  if (lines.some((line) => line.endsWith('nothing to upload'))) return '"nothing to upload"';
  const found = numbersIn(lines, /\bFound (\d+) chunks to upload$/);
  if (found.length === 0) return 'no "Found N chunks to upload" line';
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

// Step 5, the real upload of the bundle's maps, separate from the credential
// check in step 2. Its log, but for the credential line, is printed as it was written.
async function uploadBundleMaps(posthogCli: string, release: string, pairs: number, expected: CredentialSource, output: string) {
  const log = await runGated('upload', posthogCli, release, expected, output);
  const problem = uploadLogProblem(log.join(''), pairs);
  if (problem !== undefined) {
    fail(`posthog-cli sourcemap upload reported ${problem} for ${pairs} injected source map pairs; the Worker was not deployed.`);
  }
}

async function deploy() {
  // Wrangler reads nothing after `--` as an option, so this script's own flags,
  // which follow the arguments it was given, would have no effect.
  if (wranglerArgs.includes('--')) fail('remove "--" from the arguments for wrangler. Nothing was built or deployed.');
  const expectedSource = credentialMode();

  // npm installs these tools as .cmd shims on Windows, which spawning without a
  // shell cannot run, so each package's own entry point, found from the
  // repository root npm runs this script in, runs with this Node.
  const require = createRequire(join(process.cwd(), 'package.json'));
  const wrangler = binPath(require.resolve('wrangler/package.json'), 'wrangler');
  const posthogCli = binPath(require.resolve('@posthog/cli/package.json'), 'posthog-cli');

  checkCliVersion(posthogCli);
  checkCredentials(posthogCli, expectedSource);

  // Step 3 bundles the Worker and injects chunk ids. The commit names the
  // release the maps are uploaded under.
  const release = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  // The chunk id written into the bundle is what links an error report
  // to its source map, so the deployed bundle has to be the injected one.
  // Without bundling, wrangler uploads every module in the folder, so each run
  // bundles into a new, empty folder of its own and removes only that folder.
  // Another deploy from this checkout then cannot replace or delete this
  // run's bundle between its upload and step 6.
  mkdirSync('.wrangler', { recursive: true });
  const output = mkdtempSync(join('.wrangler', 'posthog-worker-'));
  try {
    // The arguments for wrangler come before this script's own flags. Wrangler
    // keeps the last value of --dry-run or --bundle and refuses a second --outdir
    // or --config, so no argument can make this build publish or the final
    // deploy bundle again.
    run('wrangler deploy --dry-run', wrangler, ['deploy', ...wranglerArgs, '--dry-run', '--outdir', output]);
    await runGated('inject', posthogCli, release, expectedSource, output);
    const pairs = countInjectedPairs(output);
    await uploadBundleMaps(posthogCli, release, pairs, expectedSource, output);
    // Step 6.
    run('wrangler deploy', wrangler, ['deploy', join(output, 'instrumentation.js'), ...wranglerArgs, '--no-bundle', '--config', 'wrangler.toml']);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

try {
  await deploy();
} catch (error) {
  if (!(error instanceof Stop)) throw error;
  console.error(`worker:deploy: ${error.message}`);
  process.exitCode = error.code;
}
