import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const release = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const output = '.wrangler/posthog-worker';
const sourceMaps = (command: string) => [
  '--host', 'https://eu.i.posthog.com', 'sourcemap', command, '--directory', output,
  '--release-name', 'papertok-worker', '--release-version', release,
];

if (!process.env.POSTHOG_CLI_API_KEY || !process.env.POSTHOG_CLI_PROJECT_ID) {
  throw new Error('POSTHOG_CLI_API_KEY and POSTHOG_CLI_PROJECT_ID are required to deploy with readable error traces.');
}

// The chunk id written into the bundle is what links an error report to its
// source map, so the deployed bundle has to be the injected one. Without
// bundling, wrangler uploads every module in the folder, so it starts empty.
rmSync(output, { recursive: true, force: true });
execFileSync('wrangler', ['deploy', '--dry-run', '--outdir', output, ...process.argv.slice(2)], { stdio: 'inherit' });
execFileSync('posthog-cli', sourceMaps('inject'), { stdio: 'inherit' });
execFileSync('posthog-cli', sourceMaps('upload'), { stdio: 'inherit' });
execFileSync('wrangler', ['deploy', `${output}/instrumentation.js`, '--no-bundle', '--config', 'wrangler.toml', ...process.argv.slice(2)], { stdio: 'inherit' });
