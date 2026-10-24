import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

// AGENTS.md names the lint rule behind each enforced rule as `[lint: <rule id>]`.
// A tag whose rule is not enabled describes a check that does not run.

const root = fileURLToPath(new URL('..', import.meta.url));
const instructionFiles = ['AGENTS.md', 'src/AGENTS.md', 'worker/AGENTS.md'];
// One file per area whose configuration differs.
const sampleFiles = ['src/App.tsx', 'src/utils/publicNavigation.test.ts', 'src/styles/variables.css', 'worker/index.ts', 'worker/index.test.ts', 'proxy/scopus-proxy.ts'];

function lintTags(text: string) {
  return [...text.matchAll(/\[lint: ([^\]]+)\]/g)].map(match => match[1].trim());
}

async function enabledRules() {
  const eslint = new ESLint({ cwd: root, flags: ['unstable_native_nodejs_ts_config'] });
  const enabled = new Set<string>();
  for (const file of sampleFiles) {
    const config = await eslint.calculateConfigForFile(file) as { rules?: Record<string, unknown> };
    for (const [id, entry] of Object.entries(config.rules ?? {})) {
      const severity = Array.isArray(entry) ? entry[0] : entry;
      if (severity === 2 || severity === 'error') enabled.add(id);
    }
  }
  return enabled;
}

test('every [lint: …] tag in the agent instructions names a rule that fails the lint', async () => {
  const tags = instructionFiles.flatMap(file => lintTags(readFileSync(new URL(file, `file://${root}`), 'utf8')));
  assert.ok(tags.length > 0, 'AGENTS.md lists no enforced rules');
  const enabled = await enabledRules();
  assert.deepEqual(tags.filter(tag => !enabled.has(tag)), []);
});

test('a tag for a rule that is not enabled is reported', async () => {
  const enabled = await enabledRules();
  const tags = lintTags('| Example | [lint: no-restricted-imports], [lint: example/not-a-rule] |');
  assert.deepEqual(tags.filter(tag => !enabled.has(tag)), ['example/not-a-rule']);
});
