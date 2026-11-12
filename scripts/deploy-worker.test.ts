import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// These tests run the real wrapper against a throwaway project whose node_modules
// holds fake wrangler and posthog-cli bins. The fakes record every call and act
// like the real tools on the parts the wrapper depends on (posthog-cli 0.18.12):
// - `--version` alone prints `posthog-cli 0.18.12` and exits before anything else;
// - clap reads POSTHOG_CLI_DRY_RUN, POSTHOG_CLIENT_RATE_LIMIT, POSTHOG_RELEASE_MODE
//   (inject and upload, when --release-mode is not given) and
//   POSTHOG_CLI_SOURCEMAP_UPLOAD_CONCURRENCY (upload) after the command line, so any
//   call but `--version` exits 2 before its command when one holds a value clap
//   does not accept, such as empty;
// - every sourcemap command resolves credentials once, first, from POSTHOG_CLI_API_KEY
//   (or the legacy POSTHOG_CLI_TOKEN) with POSTHOG_CLI_PROJECT_ID (or the legacy
//   POSTHOG_CLI_ENV_ID), then a --dotenv-file, then the `posthog-cli login` session,
//   which each process reads again when it starts;
// - with RUST_LOG enabling posthog_cli::utils::auth at debug, the chosen source
//   is logged by tracing-subscriber, with ANSI colours unless NO_COLOR is set;
// - with --stdin, inject and upload then read folder paths from their input until
//   it ends, and only then act on the project their credentials name: inject fetches
//   or creates the release, upload sends the maps. With no path, inject exits 1 with
//   "no source files found" and upload exits 0 with "nothing to upload", both without
//   a request;
// - inject marks each script it pairs with a map: a `//# chunkId=<id>` comment in
//   the script and a top-level "chunk_id" in the map;
// - upload skips scripts without a chunk id, logs "Found N chunks to upload" at info
//   and exits 0 with "nothing to upload" when nothing is left; otherwise it logs
//   "Upload summary: X chunk(s) uploaded, Y skipped (Z already present, W too large)"
//   at info after its requests. In symbol-set release mode it also resolves the release.
// Variables the wrapper never reads steer the fakes:
// - DEPLOY_WORKER_TEST_LOG: the file each call appends JSON lines to;
// - DEPLOY_WORKER_TEST_VERSION: what `posthog-cli --version` prints instead of `posthog-cli 0.18.12`;
// - DEPLOY_WORKER_TEST_LOGIN_PROJECT: the project of the stored login session, if any;
// - DEPLOY_WORKER_TEST_RELOGIN: `<moment>:<project>` logs in to another project at that
//   moment: `build` after the bundle is written, `inject` or `upload` right after that
//   call's credential line, `between` when inject has finished;
// - DEPLOY_WORKER_TEST_FAIL: build, inject, upload or deploy exits with DEPLOY_WORKER_TEST_EXIT (default 1);
// - DEPLOY_WORKER_TEST_AUTH_SOURCE: `file` or `environment`, the source the CLI reports whatever it used;
// - DEPLOY_WORKER_TEST_AUTH_LOG: `changed` words the debug line differently, `suffix` adds text
//   after the project, `silent` drops it;
// - DEPLOY_WORKER_TEST_GATE: `<check|inject|upload>:<mode>`, comma-separated, changes how that call
//   logs its credentials: `late` waits 300 ms first, `split` writes the line in three pieces,
//   `longer` writes it up to the project and then one more digit, `crlf` ends it with CRLF,
//   `changed` words it differently, `suffix` adds text after the project, `twice` writes it
//   twice at once, `after` writes it again once a folder was read, `source` names the other
//   source, `silent` writes none and waits for its input, `exit` writes none and exits 0,
//   `hang` writes none and never exits;
// - DEPLOY_WORKER_TEST_BUILD: `extra-script` adds a script without a source map,
//   `nested-script` adds one in a subfolder, `renamed-entry` names the bundle index.js
//   instead of instrumentation.js;
// - DEPLOY_WORKER_TEST_INJECT: `no-marker` exits 0 without marking anything, `mismatch` writes
//   another id into the map than into the script, `orphan-map` adds a map without a script,
//   `no-pairs` exits 0 after removing every script and map;
// - DEPLOY_WORKER_TEST_UPLOAD: `zero` selects no chunk although some are marked, `count` reports
//   one chunk more than it selected, `found-twice` logs its chunk count twice, `warning` also
//   logs "nothing to upload", `killed` exits 0 before the summary, `too-large` and `empty-map`
//   leave one chunk out of the summary's uploaded and present counts, `already-present`
//   reports every chunk as already present.

const wrapper = fileURLToPath(new URL('deploy-worker.ts', import.meta.url));
const eu = 'https://eu.i.posthog.com';
const project = '306340';
const apiKey = 'phx_contract_test_key';
const out = join('.wrangler', 'posthog-worker');
const posthogVariables = [
  'POSTHOG_CLI_API_KEY', 'POSTHOG_CLI_PROJECT_ID', 'POSTHOG_CLI_TOKEN', 'POSTHOG_CLI_ENV_ID',
  'POSTHOG_CLI_HOST', 'POSTHOG_CLI_DOTENV_FILE', 'POSTHOG_CLI_DRY_RUN', 'POSTHOG_HOME',
  'POSTHOG_CLIENT_RATE_LIMIT', 'POSTHOG_RELEASE_MODE', 'POSTHOG_CLI_SOURCEMAP_UPLOAD_CONCURRENCY',
];
// A raw line the fake upload writes to stderr, which the wrapper must pass through as written.
const uploadLog = 'fake upload log: \u001b[1mcolour codes kept\u001b[0m';

const fakeTool = String.raw`'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const tool = path.basename(__filename) === 'run-posthog-cli.js' ? 'posthog-cli' : 'wrangler';
const argv = process.argv.slice(2);
const env = process.env;
const id = randomUUID();
const failure = env.DEPLOY_WORKER_TEST_FAIL;
const failureCode = Number(env.DEPLOY_WORKER_TEST_EXIT || '1');
const VARIABLES = ${JSON.stringify(posthogVariables)};
const UPLOAD_LOG = ${JSON.stringify(uploadLog)};
const LEVELS = ['off', 'error', 'warn', 'info', 'debug', 'trace'];
const AUTH = 'posthog_cli::utils::auth';
const UPLOAD = 'posthog_cli::sourcemaps::plain::upload';
const loginFile = path.join(path.dirname(env.DEPLOY_WORKER_TEST_LOG), 'login.json');
const [reloginMoment, reloginProject] = (env.DEPLOY_WORKER_TEST_RELOGIN || '').split(':');

function option(name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function filesIn(directory) {
  if (!directory || !fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { recursive: true })
    .map((name) => path.join(directory, String(name)))
    .filter((file) => fs.statSync(file).isFile());
}

function record(step, details) {
  const present = {};
  for (const name of VARIABLES) present[name] = env[name] !== undefined;
  const call = { id, tool, step, argv, env: present, rustLog: env.RUST_LOG === undefined ? null : env.RUST_LOG, ...details };
  fs.appendFileSync(env.DEPLOY_WORKER_TEST_LOG, JSON.stringify(call) + '\n');
}

// Adds to this call's record: what it read from its input, or a request it made.
function note(details) {
  fs.appendFileSync(env.DEPLOY_WORKER_TEST_LOG, JSON.stringify({ id, ...details }) + '\n');
}

function relogin(moment) {
  if (reloginMoment === moment) fs.writeFileSync(loginFile, JSON.stringify({ project: reloginProject }));
}

function stop(message, code) {
  fs.writeSync(2, message + '\n');
  process.exit(code === undefined ? failureCode : code);
}

// tracing-subscriber's EnvFilter as main.rs builds it: the longest matching target
// directive wins, and INFO applies only when RUST_LOG holds no valid directive.
function level(target) {
  const directives = [];
  for (const raw of (env.RUST_LOG || '').split(',')) {
    const text = raw.trim();
    if (!text) continue;
    const at = text.lastIndexOf('=');
    if (at === -1) {
      if (LEVELS.includes(text.toLowerCase())) directives.push({ target: '', level: text.toLowerCase() });
      else directives.push({ target: text, level: 'trace' });
      continue;
    }
    const value = text.slice(at + 1).toLowerCase();
    if (LEVELS.includes(value)) directives.push({ target: text.slice(0, at), level: value });
  }
  if (directives.length === 0) directives.push({ target: '', level: 'info' });
  const match = directives
    .filter((directive) => target.startsWith(directive.target))
    .sort((a, b) => b.target.length - a.target.length)[0];
  return match ? match.level : 'off';
}

// The line tracing-subscriber writes, or null when RUST_LOG filters it out.
function formatted(name, target, message) {
  if (LEVELS.indexOf(level(target)) < LEVELS.indexOf(name)) return null;
  const label = name.toUpperCase().padStart(5);
  const time = new Date().toISOString();
  const colour = { error: 31, warn: 33, info: 32, debug: 34, trace: 35 }[name];
  return env.NO_COLOR
    ? time + ' ' + label + ' ' + target + ': ' + message
    : '\u001b[2m' + time + '\u001b[0m \u001b[' + colour + 'm' + label + '\u001b[0m \u001b[2m' + target
      + '\u001b[0m\u001b[2m:\u001b[0m ' + message;
}

function log(name, target, message) {
  const line = formatted(name, target, message);
  if (line !== null) fs.writeSync(2, line + '\n');
}

function isMarked(file) {
  return /^\/\/# chunkId=/m.test(fs.readFileSync(file, 'utf8'));
}

function mapFor(file) {
  const reference = /^\/\/[#@] sourceMappingURL=(.+)$/m.exec(fs.readFileSync(file, 'utf8'));
  const candidates = [reference && path.join(path.dirname(file), reference[1].trim()), file + '.map'];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

function pairsIn(directory) {
  return filesIn(directory).filter((file) => /\.[cm]?js$/.test(file))
    .map((file) => ({ file, map: mapFor(file) })).filter((pair) => pair.map !== undefined);
}

function uploadableIn(directory) {
  return pairsIn(directory).filter((pair) => isMarked(pair.file) || JSON.parse(fs.readFileSync(pair.map, 'utf8')).debugId);
}

function wrangler() {
  if (argv[0] !== 'deploy') stop('fake wrangler: unexpected command', 1);
  if (argv.includes('--dry-run')) {
    const outdir = option('--outdir') === undefined ? null : path.resolve(option('--outdir'));
    record('build', { outdir, outdirBefore: outdir && fs.existsSync(outdir) ? fs.readdirSync(outdir) : null });
    if (failure === 'build') stop('X [ERROR] Build failed with 1 error');
    if (!outdir) stop('fake wrangler: --outdir is required', 1);
    fs.mkdirSync(outdir, { recursive: true });
    const entry = env.DEPLOY_WORKER_TEST_BUILD === 'renamed-entry' ? 'index.js' : 'instrumentation.js';
    fs.writeFileSync(path.join(outdir, entry),
      'export default { fetch() { return new Response("ok"); } };\n//# sourceMappingURL=' + entry + '.map\n');
    fs.writeFileSync(path.join(outdir, entry + '.map'), JSON.stringify({
      version: 3, sources: ['../../worker/instrumentation.ts'], sourcesContent: ['export default {};\n'], names: [], mappings: 'AAAA',
    }));
    if (env.DEPLOY_WORKER_TEST_BUILD === 'extra-script') {
      fs.writeFileSync(path.join(outdir, 'chunk.js'), 'export const chunk = 1;\n');
    }
    if (env.DEPLOY_WORKER_TEST_BUILD === 'nested-script') {
      fs.mkdirSync(path.join(outdir, 'chunks'));
      fs.writeFileSync(path.join(outdir, 'chunks', 'chunk.js'), 'export const chunk = 1;\n');
    }
    relogin('build');
    process.exit(0);
  }
  const script = argv.slice(1).find((arg) => /\.m?js$/.test(arg));
  const entry = script === undefined ? null : path.resolve(script);
  record('deploy', { entry, entryInjected: entry !== null && fs.existsSync(entry) && isMarked(entry) });
  if (failure === 'deploy') stop('X [ERROR] A request to the Cloudflare API failed.');
  if (entry === null || !fs.existsSync(entry)) stop('X [ERROR] The entry-point file was not found.', 1);
  process.exit(0);
}

function credentialsFrom(lookup, source) {
  const token = lookup('POSTHOG_CLI_API_KEY') ?? lookup('POSTHOG_CLI_TOKEN');
  const id = lookup('POSTHOG_CLI_PROJECT_ID') ?? lookup('POSTHOG_CLI_ENV_ID');
  return token === undefined || id === undefined ? undefined : { source, token, id };
}

function storedSessionFile() {
  return path.join(env.POSTHOG_HOME !== undefined ? env.POSTHOG_HOME : path.join(os.homedir(), '.posthog'), 'credentials.json');
}

function resolveCredentials(dotenvFile) {
  const fromEnvironment = credentialsFrom((name) => env[name], 'environment');
  if (fromEnvironment) return fromEnvironment;
  if (dotenvFile && fs.existsSync(dotenvFile)) {
    const values = {};
    for (const line of fs.readFileSync(dotenvFile, 'utf8').split(/\r?\n/)) {
      const at = line.indexOf('=');
      if (at > 0 && !line.trim().startsWith('#')) values[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    const fromFile = credentialsFrom((name) => values[name], 'environment');
    if (fromFile) return fromFile;
    stop("Oops! Couldn't find POSTHOG_CLI_API_KEY and POSTHOG_CLI_PROJECT_ID in process env or " + dotenvFile, 1);
  }
  // The stored session is read again by every process, so a new login reaches the next one.
  const stored = fs.existsSync(loginFile) ? JSON.parse(fs.readFileSync(loginFile, 'utf8')).project : env.DEPLOY_WORKER_TEST_LOGIN_PROJECT;
  return stored === undefined ? undefined : { source: 'file', token: 'phx_stored_session', id: stored };
}

function credentialLine(credentials, reported, mode) {
  if (env.DEPLOY_WORKER_TEST_AUTH_LOG === 'silent') return null;
  if (env.DEPLOY_WORKER_TEST_AUTH_LOG === 'changed' || mode === 'changed') {
    return formatted('debug', AUTH, 'Loaded credentials for project ' + credentials.id);
  }
  const suffix = env.DEPLOY_WORKER_TEST_AUTH_LOG === 'suffix' || mode === 'suffix' ? ' (EU)' : '';
  return formatted('debug', AUTH, (reported === 'file'
    ? 'Using token from: ' + storedSessionFile() + ', for environment ' + credentials.id
    : 'Using token from environment or --dotenv-file, for environment ' + credentials.id) + suffix);
}

function validate(credentials) {
  if (!credentials.token.startsWith('phx_')) stop('Oops! Invalid Personal API key: "Token looks wrong, must start with \'phx_\'"', 1);
  if (!/^[0-9]+$/.test(credentials.id)) stop('Oops! Invalid Environment ID: "Environment ID must be a number"', 1);
}

function request(kind, credentials) {
  note({ request: { kind, project: credentials.id } });
}

function inject(directory, credentials) {
  const pairs = pairsIn(directory);
  if (pairs.length === 0) stop('Oops! no source files found', 1);
  // Both release modes fetch or create the release before writing anything.
  request('release', credentials);
  if (failure === 'inject') stop('Oops! Request failed');
  const mode = env.DEPLOY_WORKER_TEST_INJECT;
  if (mode !== 'no-marker') {
    const release = randomUUID();
    for (const pair of pairs) {
      if (isMarked(pair.file)) continue;
      const chunkId = randomUUID();
      const snippet = '!function(){try{var e=globalThis;e._posthogReleaseId=e._posthogReleaseId||"' + release
        + '";var n=(new e.Error).stack;n&&(e._posthogChunkIds=e._posthogChunkIds||{},e._posthogChunkIds[n]="' + chunkId + '")}catch(e){}}();';
      fs.writeFileSync(pair.file, snippet + fs.readFileSync(pair.file, 'utf8') + '\n//# chunkId=' + chunkId);
      const map = JSON.parse(fs.readFileSync(pair.map, 'utf8'));
      // serde_json writes chunk_id first; the other fields keep BTreeMap order.
      const marked = { chunk_id: mode === 'mismatch' ? randomUUID() : chunkId };
      for (const key of Object.keys(map).sort()) if (key !== 'chunk_id' && key !== 'chunkId') marked[key] = map[key];
      fs.writeFileSync(pair.map, JSON.stringify(marked));
    }
  }
  if (mode === 'orphan-map') {
    fs.writeFileSync(path.join(directory, 'orphan.js.map'), JSON.stringify({ chunk_id: randomUUID(), version: 3, sources: [], names: [], mappings: '' }));
  }
  if (mode === 'no-pairs') {
    for (const file of filesIn(directory)) if (/\.([cm]?js|map)$/.test(file)) fs.rmSync(file);
  }
  log('info', 'posthog_cli::sourcemaps::inject', 'injecting done');
  relogin('between');
  process.exit(0);
}

function upload(directory, credentials, releaseMode) {
  fs.writeSync(2, UPLOAD_LOG + '\n');
  const mode = env.DEPLOY_WORKER_TEST_UPLOAD;
  const selected = mode === 'zero' ? 0 : uploadableIn(directory).length;
  const count = mode === 'count' ? selected + 1 : selected;
  log('info', UPLOAD, 'Found ' + count + ' chunks to upload');
  if (mode === 'found-twice') log('info', UPLOAD, 'Found ' + count + ' chunks to upload');
  if (selected === 0 || mode === 'warning') {
    log('warn', UPLOAD, 'No source map pairs with uploadable IDs were found; nothing to upload');
  }
  if (selected === 0) process.exit(0);
  if (releaseMode === 'symbol-set') request('release', credentials);
  request('symbol-sets', credentials);
  // The npm launcher exits 0 when a signal kills the binary mid-upload.
  if (mode === 'killed') process.exit(0);
  const present = mode === 'already-present' ? selected : 0;
  const tooLarge = mode === 'too-large' ? 1 : 0;
  // A pair with an empty map is dropped before the requests, so the summary leaves it out.
  const uncounted = mode === 'empty-map' ? 1 : 0;
  const uploaded = selected - present - tooLarge - uncounted;
  log('info', 'posthog_cli::api::symbol_sets', 'Upload summary: ' + uploaded + ' chunk(s) uploaded, ' + (present + tooLarge)
    + ' skipped (' + present + ' already present, ' + tooLarge + ' too large)');
  if (failure === 'upload') stop('Oops! Request failed');
  process.exit(0);
}

// --stdin: the credential line comes first, then the folders on the input, and
// only then any request. Folders written before the line show up in inputBeforeAuth.
function gated(step, credentials, reported, mode, releaseMode) {
  let input = '';
  let inputBeforeAuth = null;
  let ended = false;
  let announced = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
    note({ input });
  });
  if (mode === 'exit') process.exit(0);
  if (mode === 'hang') {
    setInterval(() => {}, 1000);
    return;
  }
  const finish = () => {
    const directories = input.split('\n').map((entry) => entry.trim()).filter(Boolean).map((entry) => path.resolve(entry));
    const directory = directories.length > 0 ? directories[0] : null;
    note({ input, inputBeforeAuth, directory, uploadable: uploadableIn(directory).length });
    if (directory === null) {
      if (step === 'inject') stop('Oops! no source files found', 1);
      log('info', UPLOAD, 'Found 0 chunks to upload');
      log('warn', UPLOAD, 'No source map pairs with uploadable IDs were found; nothing to upload');
      process.exit(0);
    }
    if (mode === 'after') fs.writeSync(2, credentialLine(credentials, reported, mode) + '\n');
    if (step === 'inject') inject(directory, credentials);
    else upload(directory, credentials, releaseMode);
  };
  process.stdin.on('end', () => {
    ended = true;
    if (announced) finish();
  });
  const line = mode === 'silent' ? null : credentialLine(credentials, reported, mode);
  const pieces = (parts, done) => {
    fs.writeSync(2, parts[0]);
    if (parts.length === 1) done();
    else setTimeout(() => pieces(parts.slice(1), done), 100);
  };
  const afterLine = () => {
    validate(credentials);
    relogin(step);
    announced = true;
    if (ended) finish();
  };
  const writeLine = () => {
    inputBeforeAuth = input;
    if (line === null) return afterLine();
    const text = line + (mode === 'crlf' ? '\r\n' : '\n');
    const third = Math.floor(text.length / 3);
    if (mode === 'split') return pieces([text.slice(0, third), text.slice(third, 2 * third), text.slice(2 * third)], afterLine);
    if (mode === 'longer') return pieces([line, '1\n'], afterLine);
    fs.writeSync(2, mode === 'twice' ? text + text : text);
    afterLine();
  };
  if (mode === 'late') setTimeout(writeLine, 300);
  else writeLine();
}

function posthog() {
  // clap answers --version while parsing, before credentials or any command.
  if (argv.length === 1 && argv[0] === '--version') {
    record('version', {});
    fs.writeSync(1, (env.DEPLOY_WORKER_TEST_VERSION || 'posthog-cli 0.18.12') + '\n');
    process.exit(0);
  }
  const globals = {};
  let index = 0;
  while (index < argv.length && argv[index].startsWith('--')) {
    const [flag, inline] = argv[index].split('=');
    const takesValue = ['--host', '--rate-limit', '--dotenv-file', '--env-file'].includes(flag);
    globals[flag] = inline !== undefined ? inline : takesValue ? argv[index + 1] : 'true';
    index += takesValue && inline === undefined ? 2 : 1;
  }
  const [group, command] = argv.slice(index, index + 2);
  const stdin = argv.includes('--stdin');
  const directory = option('--directory') === undefined ? null : path.resolve(option('--directory'));
  // The wrapper's credential check is the only upload without a release.
  const step = command !== 'inject' && command !== 'upload' ? 'unknown'
    : command === 'upload' && option('--release-version') === undefined ? 'check' : command;
  // A value on the command line wins over the variable, which clap then never reads.
  const releaseMode = option('--release-mode') !== undefined ? option('--release-mode') : env.POSTHOG_RELEASE_MODE !== undefined ? env.POSTHOG_RELEASE_MODE : 'event';
  const concurrency = option('--concurrency') !== undefined ? option('--concurrency') : env.POSTHOG_CLI_SOURCEMAP_UPLOAD_CONCURRENCY;
  record(step, {
    host: globals['--host'] === undefined ? null : globals['--host'],
    stdin,
    directory,
    releaseMode,
    levels: {
      auth: level(AUTH),
      upload: level(UPLOAD),
      client: level('posthog_cli::api::client'),
      http: level('reqwest::connect'),
    },
  });

  // clap's parsers reject any other value, an empty one included, before the command runs.
  const invalid = (value, flag) => stop("error: invalid value '" + value + "' for '" + flag + "'", 2);
  const dryRun = globals['--dry-run'] !== undefined ? globals['--dry-run'] : env.POSTHOG_CLI_DRY_RUN;
  if (dryRun !== undefined && !/^(y|yes|t|true|on|1|n|no|f|false|off|0)$/i.test(dryRun)) invalid(dryRun, '--dry-run[=<DRY_RUN>]');
  const rateLimit = globals['--rate-limit'] !== undefined ? globals['--rate-limit'] : env.POSTHOG_CLIENT_RATE_LIMIT;
  if (rateLimit !== undefined && !/^\+?[0-9]+$/.test(rateLimit)) invalid(rateLimit, '--rate-limit <RATE_LIMIT>');
  if (group === 'sourcemap' && (command === 'inject' || command === 'upload') && releaseMode !== 'event' && releaseMode !== 'symbol-set') {
    invalid(releaseMode, '--release-mode <RELEASE_MODE>');
  }
  if (group === 'sourcemap' && command === 'upload' && concurrency !== undefined && !/^\+?0*[1-9][0-9]*$/.test(concurrency)) {
    invalid(concurrency, '--concurrency <CONCURRENCY>');
  }
  if (dryRun && /^(y|yes|t|true|on|1)$/i.test(dryRun)) {
    log('warn', 'posthog_cli::commands', 'Dry run enabled (--dry-run / POSTHOG_CLI_DRY_RUN): skipping the sourcemap step. Nothing was sent to PostHog and no credentials were used. Do not use --dry-run for release builds.');
    process.exit(0);
  }
  if (group !== 'sourcemap' || (command !== 'inject' && command !== 'upload')) stop('error: unrecognized subcommand', 2);

  const credentials = resolveCredentials(globals['--dotenv-file'] || globals['--env-file'] || env.POSTHOG_CLI_DOTENV_FILE);
  if (!credentials) {
    stop('Oops! While trying to read credentials from file "' + storedSessionFile() + '"\n\nCaused by:\n'
      + "    0: Couldn't find POSTHOG_CLI_API_KEY and POSTHOG_CLI_PROJECT_ID in process env\n"
      + "    1: Couldn't load credentials... Have you logged in recently?", 1);
  }
  const gateMode = (env.DEPLOY_WORKER_TEST_GATE || '').split(',').map((entry) => entry.split(':'))
    .find(([target]) => stdin && target === step);
  const mode = gateMode ? gateMode[1] : undefined;
  const other = credentials.source === 'file' ? 'environment' : 'file';
  const reported = mode === 'source' ? other : env.DEPLOY_WORKER_TEST_AUTH_SOURCE || credentials.source;
  if (stdin) {
    gated(step, credentials, reported, mode, releaseMode);
    return;
  }
  const line = credentialLine(credentials, reported, undefined);
  if (line !== null) fs.writeSync(2, line + '\n');
  validate(credentials);
  if (command === 'inject') inject(directory, credentials);
  else upload(directory, credentials, releaseMode);
}

if (tool === 'wrangler') wrangler();
else posthog();
`;

interface Request {
  kind: 'release' | 'symbol-sets';
  project: string;
}

interface Call {
  id: string;
  tool: 'wrangler' | 'posthog-cli';
  step: 'version' | 'check' | 'build' | 'inject' | 'upload' | 'deploy' | 'unknown';
  argv: string[];
  env: Record<string, boolean>;
  rustLog: string | null;
  host?: string | null;
  stdin?: boolean;
  directory?: string | null;
  releaseMode?: string;
  input?: string;
  inputBeforeAuth?: string | null;
  uploadable?: number;
  levels?: Record<string, string>;
  outdir?: string | null;
  outdirBefore?: string[] | null;
  entry?: string | null;
  entryInjected?: boolean;
  requests: Request[];
}

interface Project {
  root: string;
  dir: string;
  log: string;
  release: string;
  env: Record<string, string>;
}

// git and node are the only programs the wrapper may find on PATH.
function directoryOf(command: string) {
  const name = process.platform === 'win32' ? `${command}.exe` : command;
  const found = (process.env.PATH ?? '').split(delimiter).find((entry) => entry && existsSync(join(entry, name)));
  assert.ok(found, `${command} must be on PATH to run these tests`);
  return found;
}

function write(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

// No inherited PostHog, CI or git variable, and a home and temp directory of its own.
function isolatedEnv(root: string) {
  const env: Record<string, string> = {
    PATH: [...new Set([dirname(process.execPath), directoryOf('git')])].join(delimiter),
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    TMPDIR: join(root, 'tmp'),
    TEMP: join(root, 'tmp'),
    TMP: join(root, 'tmp'),
  };
  for (const name of ['SystemRoot', 'windir']) {
    const value = process.env[name];
    if (process.platform === 'win32' && value) env[name] = value;
  }
  mkdirSync(env.HOME, { recursive: true });
  mkdirSync(env.TMPDIR, { recursive: true });
  return env;
}

// One committed project, copied for each test, so git runs once per file.
function createTemplate() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'deploy-worker-template-')));
  const dir = join(root, 'project');
  write(join(dir, 'package.json'), '{ "name": "deploy-worker-contract", "private": true }\n');
  write(join(dir, 'wrangler.toml'), 'name = "deploy-worker-contract"\nmain = "worker/instrumentation.ts"\n');
  write(join(dir, '.gitignore'), 'node_modules\n.wrangler\n');
  // The bin paths are spelled as in the installed wrangler 4.122.0 and @posthog/cli 0.18.12.
  write(join(dir, 'node_modules/wrangler/package.json'), JSON.stringify({ name: 'wrangler', bin: { wrangler: './bin/wrangler.js' } }));
  write(join(dir, 'node_modules/wrangler/bin/wrangler.js'), fakeTool);
  write(join(dir, 'node_modules/@posthog/cli/package.json'), JSON.stringify({ name: '@posthog/cli', bin: { 'posthog-cli': 'run-posthog-cli.js' } }));
  write(join(dir, 'node_modules/@posthog/cli/run-posthog-cli.js'), fakeTool);
  // A stale, already marked bundle from an earlier deploy, which the wrapper must clear.
  write(join(dir, out, 'stale.js'), 'stale\n//# sourceMappingURL=stale.js.map\n//# chunkId=stale');
  write(join(dir, out, 'stale.js.map'), '{"chunk_id":"stale","version":3,"sources":["stale.ts"],"names":[],"mappings":"AAAA"}');

  const env = isolatedEnv(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base');
  return { root, dir, release: git('rev-parse', 'HEAD') };
}

const template = createTemplate();
after(() => rmSync(template.root, { recursive: true, force: true }));

function createProject(t: { after(fn: () => void): void }): Project {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'deploy-worker-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'project');
  cpSync(template.dir, dir, { recursive: true });
  const log = join(root, 'calls.jsonl');
  return { root, dir, log, release: template.release, env: { ...isolatedEnv(root), DEPLOY_WORKER_TEST_LOG: log } };
}

// Each call writes one record when it starts, then adds what it read and the requests it made.
function readCalls(log: string): Call[] {
  if (!existsSync(log)) return [];
  const calls = new Map<string, Call>();
  for (const line of readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
    const { request, ...entry } = JSON.parse(line) as Partial<Call> & { id: string; request?: Request };
    const call = calls.get(entry.id);
    if (call === undefined) calls.set(entry.id, { ...entry, requests: [] } as Call);
    else if (request) call.requests.push(request);
    else Object.assign(call, entry);
  }
  return [...calls.values()];
}

async function deploy(p: Project, extra: Record<string, string> = {}) {
  const child = spawn(process.execPath, [...process.execArgv, wrapper, '--tag', 'test'], {
    cwd: p.dir,
    env: { ...p.env, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  const calls = readCalls(p.log);
  return { status, output, calls, steps: calls.map((call) => call.step) };
}

type Run = Awaited<ReturnType<typeof deploy>>;

const login = { DEPLOY_WORKER_TEST_LOGIN_PROJECT: project };
const ci = { CI: 'true', POSTHOG_CLI_API_KEY: apiKey, POSTHOG_CLI_PROJECT_ID: project };

function describeRun(run: Run) {
  return `steps: ${run.steps.join(' > ') || 'none'}\n${run.output}`;
}

function assertFailed(run: Run) {
  assert.equal(typeof run.status, 'number', `the wrapper did not exit by itself, ${describeRun(run)}`);
  assert.notEqual(run.status, 0, `the wrapper exited 0, ${describeRun(run)}`);
}

function credentialsSeen(call: Call) {
  return Object.entries(call.env).filter(([, present]) => present).map(([name]) => name);
}

function withPath(argv: string[], flag: string) {
  return argv.map((arg, index) => (argv[index - 1] === flag ? '<path>' : arg));
}

function atLeastDebug(level: string | undefined) {
  return level === 'debug' || level === 'trace';
}

function callOf(run: Run, step: Call['step']) {
  const call = run.calls.find((candidate) => candidate.step === step);
  assert.ok(call, `no ${step} call, ${describeRun(run)}`);
  return call;
}

// The line the wrapper prints when it stops.
function wrapperMessage(run: Run) {
  return run.output.split(/\r?\n/).find((line) => line.startsWith('worker:deploy:')) ?? '';
}

// The credential lines name the stored session's file, so none may reach the output.
function assertNoCredentialLine(p: Project, run: Run) {
  assert.doesNotMatch(run.output, /Using token from|Loaded credentials/, 'no credential line is printed');
  assert.ok(!run.output.includes(join('.posthog', 'credentials.json')), 'the stored session path is never printed');
  assert.ok(!run.output.includes(p.root), 'no path of the project is printed');
}

// Asserts the calls of a deploy that reached the end, in order.
function assertPipeline(p: Project, run: Run, userRustLog: string | null = null) {
  assert.deepEqual(run.steps, ['version', 'check', 'build', 'inject', 'upload', 'deploy'], describeRun(run));
  const [version, check, build, inject, upload, release] = run.calls;

  assert.deepEqual(version.argv, ['--version']);

  assert.deepEqual(check.argv, ['--host', eu, 'sourcemap', 'upload', '--stdin'], 'the credential check gets no path');
  assert.ok(atLeastDebug(check.levels?.auth), `RUST_LOG must enable posthog_cli::utils::auth at debug, got ${check.rustLog}`);
  for (const [target, level] of Object.entries(check.levels ?? {})) {
    if (target !== 'auth') assert.ok(!atLeastDebug(level), `RUST_LOG ${check.rustLog} also enables ${target} at ${level}`);
  }
  // inject and upload log their credential line and the upload's info lines whatever RUST_LOG holds.
  for (const call of [inject, upload]) {
    assert.ok(atLeastDebug(call.levels?.auth), `${call.step} must log its credential line, got RUST_LOG ${call.rustLog}`);
    assert.ok(call.levels?.upload === 'info', `${call.step} must log the upload's info lines, got RUST_LOG ${call.rustLog}`);
    for (const target of ['client', 'http']) {
      assert.ok(!atLeastDebug(call.levels?.[target]), `RUST_LOG ${call.rustLog} also enables ${target} at debug`);
    }
  }
  for (const call of [version, build, release]) {
    assert.equal(call.rustLog, userRustLog, `${call.step} must inherit RUST_LOG unchanged`);
  }
  assertNoCredentialLine(p, run);
  // The credential check's input is closed from the start, so it reads no folder.
  assert.equal(check.input, '', 'the credential check reads nothing from its input');
  assert.equal(check.directory, null);
  assert.deepEqual(check.requests, [], 'the credential check sends nothing');

  assert.deepEqual(withPath(build.argv, '--outdir'), ['deploy', '--dry-run', '--outdir', '<path>', '--tag', 'test']);
  assert.equal(relative(p.dir, build.outdir ?? ''), out);
  assert.equal(build.outdirBefore, null, 'the output directory is removed before the build');

  // The folder comes on the input only, after the credential line.
  const sourceMaps = (command: string) => [
    '--host', eu, 'sourcemap', command, '--stdin',
    '--release-name', 'papertok-worker', '--release-version', p.release, '--release-mode', 'event',
  ];
  for (const [call, command] of [[inject, 'inject'], [upload, 'upload']] as const) {
    assert.deepEqual(call.argv, sourceMaps(command));
    assert.equal(call.input, `${resolve(p.dir, out)}\n`, `${command} reads the bundle folder from its input`);
    assert.equal(call.inputBeforeAuth, '', `${command} gets nothing before its credential line`);
    assert.equal(relative(p.dir, call.directory ?? ''), out);
    assert.equal(call.releaseMode, 'event');
  }
  assert.deepEqual(inject.requests, [{ kind: 'release', project }], 'inject resolves the release in project 306340');
  assert.deepEqual(upload.requests, [{ kind: 'symbol-sets', project }], 'upload sends the maps to project 306340');
  assert.ok((upload.uploadable ?? 0) > 0, 'upload receives the injected source maps');
  assert.ok(run.output.includes(uploadLog), 'the upload log is passed through as written');

  assert.deepEqual([release.argv[0], ...release.argv.slice(2)], ['deploy', '--no-bundle', '--config', 'wrangler.toml', '--tag', 'test']);
  assert.equal(relative(p.dir, release.entry ?? ''), join(out, 'instrumentation.js'));
  assert.equal(release.entryInjected, true, 'the deployed bundle is the injected one');

  for (const call of run.calls) {
    assert.ok(!call.argv.includes('--no-fail'), `${call.step} must not pass --no-fail`);
    assert.ok(!call.argv.some((arg) => arg.includes(apiKey)), `${call.step} must not receive the API key as an argument`);
  }
}

const refusals: [string, Record<string, string>, RegExp][] = [
  ['CI without credentials', { ...login, CI: 'true' }, /POSTHOG_CLI_API_KEY|POSTHOG_CLI_PROJECT_ID/],
  ['only the API key', { ...login, POSTHOG_CLI_API_KEY: apiKey }, /POSTHOG_CLI_PROJECT_ID/],
  ['only the project ID', { ...login, POSTHOG_CLI_PROJECT_ID: project }, /POSTHOG_CLI_API_KEY/],
  ['CI with only the API key', { ...login, CI: 'true', POSTHOG_CLI_API_KEY: apiKey }, /POSTHOG_CLI_PROJECT_ID/],
  ['another project ID', { ...ci, POSTHOG_CLI_PROJECT_ID: '999999' }, /306340/],
  // An empty value counts as set. With only one variable set, posthog-cli would
  // use the login session; with both empty, it would take an empty key.
  ['an empty API key alone beside a login session', { ...login, POSTHOG_CLI_API_KEY: '' }, /even to an empty value/],
  ['an empty project ID alone beside a login session', { ...login, POSTHOG_CLI_PROJECT_ID: '' }, /even to an empty value/],
  ['both variables empty beside a login session', { ...login, POSTHOG_CLI_API_KEY: '', POSTHOG_CLI_PROJECT_ID: '' }, /even to an empty value/],
  ['an empty API key with project 306340', { ...login, POSTHOG_CLI_API_KEY: '', POSTHOG_CLI_PROJECT_ID: project }, /POSTHOG_CLI_API_KEY/],
];
// The legacy aliases, a dotenv file and another PostHog home each give posthog-cli
// a credential source the wrapper did not choose. Paths are filled in per test.
const otherSources: Record<string, string> = {
  POSTHOG_CLI_TOKEN: apiKey, POSTHOG_CLI_ENV_ID: project, POSTHOG_CLI_DOTENV_FILE: '', POSTHOG_HOME: '',
};
for (const [name, value] of Object.entries(otherSources)) {
  refusals.push([`${name} beside a login session`, { ...login, [name]: value }, new RegExp(name)]);
  refusals.push([`${name} beside complete CI credentials`, { ...ci, [name]: value }, new RegExp(name)]);
}
// posthog-cli reads "no" as off and rejects "garbage", but only unset, empty or "false" is accepted.
const dryRunRefused = /POSTHOG_CLI_DRY_RUN: only unset, empty or false is accepted/;
for (const value of ['true', '1', 'no', 'garbage']) {
  refusals.push([`POSTHOG_CLI_DRY_RUN=${value} beside a login session`, { ...login, POSTHOG_CLI_DRY_RUN: value }, dryRunRefused]);
  refusals.push([`POSTHOG_CLI_DRY_RUN=${value} beside complete CI credentials`, { ...ci, POSTHOG_CLI_DRY_RUN: value }, dryRunRefused]);
}

// The check names the parsed variables that are set, never their values.
const rejectedValue = (...names: string[]) => new RegExp(
  `exit code 2\\)\\. One of the PostHog variables posthog-cli parses as options holds a value it rejects; the ones set are ${names.join(', ')}\\. Nothing`,
);

const checkFailures: [string, Record<string, string>, RegExp | null][] = [
  ['no login session and no credentials', {}, null],
  ['a login session for another project', { DEPLOY_WORKER_TEST_LOGIN_PROJECT: '999999' }, /999999/],
  ['env mode answered from the login session', { ...ci, ...login, DEPLOY_WORKER_TEST_AUTH_SOURCE: 'file' }, null],
  ['login mode answered from the environment', { ...login, DEPLOY_WORKER_TEST_AUTH_SOURCE: 'environment' }, null],
  ['a changed log line', { ...login, DEPLOY_WORKER_TEST_AUTH_LOG: 'changed' }, null],
  ['a log line with text after the project', { ...ci, DEPLOY_WORKER_TEST_AUTH_LOG: 'suffix' }, null],
  ['no log line', { ...ci, DEPLOY_WORKER_TEST_AUTH_LOG: 'silent' }, null],
  ['a credential line logged twice', { ...login, DEPLOY_WORKER_TEST_GATE: 'check:twice' }, /found more than one credential source\./],
  ['an API key the CLI rejects after naming the right source', { ...ci, POSTHOG_CLI_API_KEY: 'not-a-personal-key' }, null],
  // posthog-cli's argument parser rejects these values and exits 2 before loading credentials.
  ['POSTHOG_CLIENT_RATE_LIMIT=abc', { ...login, POSTHOG_CLIENT_RATE_LIMIT: 'abc' }, rejectedValue('POSTHOG_CLIENT_RATE_LIMIT')],
  ['POSTHOG_RELEASE_MODE=garbage', { ...login, POSTHOG_RELEASE_MODE: 'garbage' }, rejectedValue('POSTHOG_RELEASE_MODE')],
  ['POSTHOG_CLI_SOURCEMAP_UPLOAD_CONCURRENCY=0', { ...login, POSTHOG_CLI_SOURCEMAP_UPLOAD_CONCURRENCY: '0' }, rejectedValue('POSTHOG_CLI_SOURCEMAP_UPLOAD_CONCURRENCY')],
  // The empty variable is left out of the call, so the message does not name it.
  [
    'POSTHOG_CLIENT_RATE_LIMIT=abc beside accepted and empty parsed variables in CI',
    {
      ...ci, POSTHOG_CLI_DRY_RUN: 'false', POSTHOG_CLIENT_RATE_LIMIT: 'abc', POSTHOG_RELEASE_MODE: 'event',
      POSTHOG_CLI_SOURCEMAP_UPLOAD_CONCURRENCY: '',
    },
    rejectedValue('POSTHOG_CLI_DRY_RUN', 'POSTHOG_CLIENT_RATE_LIMIT', 'POSTHOG_RELEASE_MODE'),
  ],
  // posthog-cli accepts the value and fails later, with exit code 1, so the advice is the login.
  [
    'no login session beside an accepted POSTHOG_CLIENT_RATE_LIMIT',
    { POSTHOG_CLIENT_RATE_LIMIT: '10' },
    /exit code 1\)\. Run `npx posthog-cli login` with access to project 306340\. Nothing/,
  ],
];

const throughInject: Call['step'][] = ['version', 'check', 'build', 'inject'];
const throughUpload: Call['step'][] = [...throughInject, 'upload'];
const stepFailures: [string, Record<string, string>, Call['step'][]][] = [
  ['the build', { ...ci, DEPLOY_WORKER_TEST_FAIL: 'build' }, ['version', 'check', 'build']],
  ['inject', { ...ci, DEPLOY_WORKER_TEST_FAIL: 'inject' }, throughInject],
  ['an inject that marks no source map', { ...ci, DEPLOY_WORKER_TEST_INJECT: 'no-marker' }, throughInject],
  ['an inject that writes another chunk id into the map', { ...ci, DEPLOY_WORKER_TEST_INJECT: 'mismatch' }, throughInject],
  ['an inject that leaves a source map without its script', { ...ci, DEPLOY_WORKER_TEST_INJECT: 'orphan-map' }, throughInject],
  ['an inject that leaves no script and source map pair', { ...ci, DEPLOY_WORKER_TEST_INJECT: 'no-pairs' }, throughInject],
  ['a bundle with a script that has no source map', { ...ci, DEPLOY_WORKER_TEST_BUILD: 'extra-script' }, throughInject],
  ['a bundle with a script in a subfolder that has no source map', { ...ci, DEPLOY_WORKER_TEST_BUILD: 'nested-script' }, throughInject],
  ['a bundle without instrumentation.js', { ...ci, DEPLOY_WORKER_TEST_BUILD: 'renamed-entry' }, throughInject],
  ['the upload, as an invalid key in CI fails it', { ...ci, DEPLOY_WORKER_TEST_FAIL: 'upload' }, throughUpload],
  ['an upload that exits 0 after finding 0 chunks', { ...ci, DEPLOY_WORKER_TEST_UPLOAD: 'zero' }, throughUpload],
  ['an upload that exits 0 with "nothing to upload"', { ...ci, DEPLOY_WORKER_TEST_UPLOAD: 'warning' }, throughUpload],
  ['an upload that counts other chunks than the injected pairs', { ...ci, DEPLOY_WORKER_TEST_UPLOAD: 'count' }, throughUpload],
  ['an upload that logs its chunk count twice', { ...ci, DEPLOY_WORKER_TEST_UPLOAD: 'found-twice' }, throughUpload],
  ['an upload that exits 0 without its summary, as after a signal', { ...ci, DEPLOY_WORKER_TEST_UPLOAD: 'killed' }, throughUpload],
  ['an upload that skips a chunk as too large', { ...ci, DEPLOY_WORKER_TEST_UPLOAD: 'too-large' }, throughUpload],
  ['an upload that leaves out a chunk with an empty map', { ...ci, DEPLOY_WORKER_TEST_UPLOAD: 'empty-map' }, throughUpload],
  ['an upload that logs another credential line after it was given the folder', { ...ci, DEPLOY_WORKER_TEST_GATE: 'upload:after' }, throughUpload],
];

// The gate withholds the folder: the refused call reads nothing and makes no request,
// and no request ever goes to another project than 306340.
const gateRefusals: [string, Record<string, string>, 'inject' | 'upload', RegExp][] = [
  ['the login changed during the build', { ...login, DEPLOY_WORKER_TEST_RELOGIN: 'build:999999' }, 'inject', /found the posthog-cli login for project 999999\./],
  ['the login changed in inject after its credential line, which upload then logs', { ...login, DEPLOY_WORKER_TEST_RELOGIN: 'inject:999999' }, 'upload', /found the posthog-cli login for project 999999\./],
  ['the login changed between inject and upload', { ...login, DEPLOY_WORKER_TEST_RELOGIN: 'between:999999' }, 'upload', /found the posthog-cli login for project 999999\./],
  ['a credential line that goes on after a split at the project', { ...login, DEPLOY_WORKER_TEST_GATE: 'inject:longer' }, 'inject', /found the posthog-cli login for project 3063401\./],
  ['a credential line in another format', { ...login, DEPLOY_WORKER_TEST_GATE: 'inject:changed' }, 'inject', /found a credential line in another format\./],
  ['a credential line with text after the project', { ...ci, DEPLOY_WORKER_TEST_GATE: 'upload:suffix' }, 'upload', /found POSTHOG_CLI_API_KEY and POSTHOG_CLI_PROJECT_ID for project \(unrecognised\)\./],
  ['two credential lines', { ...login, DEPLOY_WORKER_TEST_GATE: 'inject:twice' }, 'inject', /found more than one credential line\./],
  ['env mode answered from the login session', { ...ci, DEPLOY_WORKER_TEST_GATE: 'inject:source' }, 'inject', /expected POSTHOG_CLI_API_KEY and POSTHOG_CLI_PROJECT_ID for project 306340, found the posthog-cli login for project 306340\./],
  ['login mode answered from the environment', { ...login, DEPLOY_WORKER_TEST_GATE: 'upload:source' }, 'upload', /expected the posthog-cli login for project 306340, found POSTHOG_CLI_API_KEY and POSTHOG_CLI_PROJECT_ID for project 306340\./],
  ['an inject that exits 0 without a credential line', { ...login, DEPLOY_WORKER_TEST_GATE: 'inject:exit' }, 'inject', /found no credential line\./],
  ['an upload that exits 0 without a credential line', { ...ci, DEPLOY_WORKER_TEST_GATE: 'upload:exit' }, 'upload', /found no credential line\./],
  ['an inject that logs no credential line', { ...login, DEPLOY_WORKER_TEST_GATE: 'inject:silent' }, 'inject', /found no credential line within 20 s\./],
  ['an upload that logs no credential line and then exits 0', { ...ci, DEPLOY_WORKER_TEST_GATE: 'upload:silent' }, 'upload', /found no credential line within 20 s\./],
  ['an inject that logs no credential line and ignores its closed input', { ...login, DEPLOY_WORKER_TEST_GATE: 'inject:hang' }, 'inject', /may still be running, without the bundle folder/],
];

// Every test owns its project directory, so they run side by side.
describe('scripts/deploy-worker.ts', { concurrency: availableParallelism() }, () => {
  test('login mode checks the CLI version and the stored session, then builds, injects, confirms, uploads and deploys', async (t) => {
    const p = createProject(t);
    const run = await deploy(p, login);
    assert.equal(run.status, 0, describeRun(run));
    assertPipeline(p, run);
    for (const call of run.calls) assert.deepEqual(credentialsSeen(call), [], `${call.step} must see no PostHog variable`);
  });

  test('env mode in CI runs the same steps with the credentials it was given', async (t) => {
    const p = createProject(t);
    const run = await deploy(p, ci);
    assert.equal(run.status, 0, describeRun(run));
    assertPipeline(p, run);
    for (const call of run.calls) {
      assert.deepEqual(credentialsSeen(call), ['POSTHOG_CLI_API_KEY', 'POSTHOG_CLI_PROJECT_ID'], `${call.step} inherits the environment unchanged`);
    }
    assert.ok(!run.output.includes(apiKey), 'the API key is never printed');
  });

  test('env mode without CI, as .env.posthog-cli supplies it, deploys too', async (t) => {
    const p = createProject(t);
    const run = await deploy(p, { POSTHOG_CLI_API_KEY: apiKey, POSTHOG_CLI_PROJECT_ID: project });
    assert.equal(run.status, 0, describeRun(run));
    assertPipeline(p, run);
  });

  test('POSTHOG_CLI_HOST is ignored because every call names the EU host', async (t) => {
    const p = createProject(t);
    const run = await deploy(p, { ...login, POSTHOG_CLI_HOST: 'https://us.i.posthog.com' });
    assert.equal(run.status, 0, describeRun(run));
    assertPipeline(p, run);
  });

  test('a redeploy whose chunks PostHog already holds deploys', async (t) => {
    const p = createProject(t);
    const run = await deploy(p, { ...ci, DEPLOY_WORKER_TEST_UPLOAD: 'already-present' });
    assert.equal(run.status, 0, describeRun(run));
    assertPipeline(p, run);
  });

  test('POSTHOG_CLI_DRY_RUN=false is accepted', async (t) => {
    const p = createProject(t);
    const run = await deploy(p, { ...login, POSTHOG_CLI_DRY_RUN: 'false' });
    assert.equal(run.status, 0, describeRun(run));
    assertPipeline(p, run);
  });

  test('POSTHOG_CLI_DRY_RUN set to empty is left out of every posthog-cli call, which would reject it', async (t) => {
    const p = createProject(t);
    const run = await deploy(p, { ...login, POSTHOG_CLI_DRY_RUN: '' });
    assert.equal(run.status, 0, describeRun(run));
    assertPipeline(p, run);
    for (const call of run.calls) {
      assert.equal(call.env.POSTHOG_CLI_DRY_RUN, call.tool === 'wrangler', `${call.tool} ${call.step}: only the wrangler calls inherit POSTHOG_CLI_DRY_RUN`);
    }
  });

  for (const name of ['POSTHOG_CLIENT_RATE_LIMIT', 'POSTHOG_RELEASE_MODE', 'POSTHOG_CLI_SOURCEMAP_UPLOAD_CONCURRENCY']) {
    test(`${name} set to empty is left out of every posthog-cli call, which would reject it`, async (t) => {
      const p = createProject(t);
      const run = await deploy(p, { ...login, [name]: '' });
      assert.equal(run.status, 0, describeRun(run));
      assertPipeline(p, run);
      for (const call of run.calls) {
        assert.equal(call.env[name], call.tool === 'wrangler', `${call.tool} ${call.step}: only the wrangler calls inherit ${name}`);
      }
    });
  }

  for (const value of ['warn', 'off']) {
    test(`RUST_LOG=${value} cannot hide the credential line or the upload's chunk count`, async (t) => {
      const p = createProject(t);
      const run = await deploy(p, { ...ci, RUST_LOG: value });
      assert.equal(run.status, 0, describeRun(run));
      assertPipeline(p, run, value);
    });
  }

  test('POSTHOG_RELEASE_MODE=symbol-set does not change the release mode of inject and upload', async (t) => {
    const p = createProject(t);
    const run = await deploy(p, { ...login, POSTHOG_RELEASE_MODE: 'symbol-set' });
    assert.equal(run.status, 0, describeRun(run));
    assertPipeline(p, run);
  });

  test('the folder is written only after a credential line that comes late', async (t) => {
    const p = createProject(t);
    const run = await deploy(p, { ...login, DEPLOY_WORKER_TEST_GATE: 'inject:late,upload:late' });
    assert.equal(run.status, 0, describeRun(run));
    assertPipeline(p, run);
  });

  test('a credential line written in pieces, or ending in CRLF, is read whole', async (t) => {
    const p = createProject(t);
    const run = await deploy(p, { ...ci, DEPLOY_WORKER_TEST_GATE: 'inject:split,upload:crlf' });
    assert.equal(run.status, 0, describeRun(run));
    assertPipeline(p, run);
  });

  test('a login changed after upload logged its credentials leaves every request in 306340', async (t) => {
    const p = createProject(t);
    const run = await deploy(p, { ...login, DEPLOY_WORKER_TEST_RELOGIN: 'upload:999999' });
    assert.equal(run.status, 0, describeRun(run));
    assertPipeline(p, run);
  });

  test('env mode keeps its project when the login changes during the build', async (t) => {
    const p = createProject(t);
    const run = await deploy(p, { ...ci, DEPLOY_WORKER_TEST_RELOGIN: 'build:999999' });
    assert.equal(run.status, 0, describeRun(run));
    assertPipeline(p, run);
  });

  for (const [name, extra, message] of refusals) {
    test(`refuses before starting any process: ${name}`, async (t) => {
      const p = createProject(t);
      // A credentials file and a PostHog home another source could read from.
      const other = join(p.root, 'other');
      write(join(other, '.env'), 'POSTHOG_CLI_API_KEY=phx_other_source\nPOSTHOG_CLI_PROJECT_ID=111111\n');
      const env = { ...extra };
      if ('POSTHOG_CLI_DOTENV_FILE' in env) env.POSTHOG_CLI_DOTENV_FILE = join(other, '.env');
      if ('POSTHOG_HOME' in env) env.POSTHOG_HOME = other;
      const run = await deploy(p, env);
      assertFailed(run);
      assert.deepEqual(run.steps, [], `no tool may run, ${describeRun(run)}`);
      assert.match(run.output, message);
      assert.ok(!run.output.includes(apiKey), 'the API key is never printed');
    });
  }

  for (const printed of ['posthog-cli 0.19.0', 'posthog-cli 0.18.12-rc.1']) {
    test(`another posthog-cli version stops the deploy before the credential check: ${printed}`, async (t) => {
      const p = createProject(t);
      const run = await deploy(p, { ...login, DEPLOY_WORKER_TEST_VERSION: printed });
      assertFailed(run);
      assert.deepEqual(run.steps, ['version'], `nothing may run after the version check, ${describeRun(run)}`);
      assert.match(run.output, /posthog-cli 0\.18\.12/);
    });
  }

  for (const [name, extra, message] of checkFailures) {
    test(`the credential check stops the deploy on ${name}`, async (t) => {
      const p = createProject(t);
      const run = await deploy(p, extra);
      assertFailed(run);
      assert.deepEqual(run.steps, ['version', 'check'], `nothing may run after the check, ${describeRun(run)}`);
      if (message) assert.match(run.output, message);
      assert.doesNotMatch(run.output, /Caused by|While trying to read credentials|invalid value/, 'the CLI output is not echoed');
      assert.ok(!run.output.includes(apiKey) && !run.output.includes('not-a-personal-key'), 'the API key is never printed');
    });
  }

  for (const [name, extra, step, message] of gateRefusals) {
    test(`the gate gives ${step} no folder and stops the deploy on ${name}`, async (t) => {
      const p = createProject(t);
      const run = await deploy(p, extra);
      assertFailed(run);
      assert.deepEqual(run.steps, step === 'inject' ? throughInject : throughUpload, describeRun(run));
      const refused = callOf(run, step);
      assert.ok(!refused.input, `${step} must read no folder, read ${JSON.stringify(refused.input)}`);
      assert.deepEqual(refused.requests, [], `${step} must make no request`);
      if (step === 'upload') assert.deepEqual(callOf(run, 'inject').requests, [{ kind: 'release', project }]);
      assert.match(wrapperMessage(run), message);
      assert.doesNotMatch(wrapperMessage(run), /[/\\]/, 'the message names no path');
      assertNoCredentialLine(p, run);
    });
  }

  for (const [name, extra, steps] of stepFailures) {
    test(`a failure in ${name} stops every later step`, async (t) => {
      const p = createProject(t);
      const run = await deploy(p, extra);
      assertFailed(run);
      assert.deepEqual(run.steps, steps, describeRun(run));
      for (const call of run.calls) {
        for (const sent of call.requests) assert.equal(sent.project, project, `${call.step} sent to another project`);
      }
    });
  }

  test('a failed final deploy passes its exit code on', async (t) => {
    const p = createProject(t);
    const run = await deploy(p, { ...ci, DEPLOY_WORKER_TEST_FAIL: 'deploy', DEPLOY_WORKER_TEST_EXIT: '3' });
    assert.deepEqual(run.steps, [...throughUpload, 'deploy'], describeRun(run));
    assert.equal(run.status, 3, describeRun(run));
  });
});
