import { execFileSync } from 'node:child_process';

const release = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const env: NodeJS.ProcessEnv = { ...process.env, SENTRY_ORG: 'papertok', SENTRY_PROJECT: 'papertok-worker' };
const output = '.wrangler/sentry-worker';

if (!env.SENTRY_AUTH_TOKEN) throw new Error('SENTRY_AUTH_TOKEN is required to deploy with readable error traces.');

execFileSync('sentry-cli', ['info'], { env, stdio: 'inherit' });
execFileSync('wrangler', ['deploy', '--outdir', output, '--upload-source-maps', '--var', `SENTRY_RELEASE:${release}`, ...process.argv.slice(2)], { env, stdio: 'inherit' });
execFileSync('sentry-cli', ['sourcemaps', 'upload', '--release', release, '--url-prefix', 'app:///', '--strip-prefix', output, output], { env, stdio: 'inherit' });
