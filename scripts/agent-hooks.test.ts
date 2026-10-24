import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const hook = join(root, 'scripts/agent-hooks.ts');

function runHook(input: object) {
  const result = spawnSync('node', [hook], { input: JSON.stringify(input), encoding: 'utf8' });
  return { status: result.status, output: result.stdout ? JSON.parse(result.stdout) : null, stderr: result.stderr };
}

function bash(command: string) {
  return runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
}

// A throwaway checkout with this repository's dependencies and a one-rule config.
function checkout(t: { after(fn: () => void): void }, files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hooks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  writeFileSync(join(dir, 'eslint.config.mjs'), "export default [{ rules: { 'no-debugger': 'error' } }]\n");
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'], { cwd: dir });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const suppressAll = ['--suppress', 'all'].join('-');

test('recording ESLint findings as suppressions is denied', () => {
  assert.equal(bash(`npx eslint . ${suppressAll}`).output.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(bash('npx eslint src --suppress-rule no-console').output.hookSpecificOutput.permissionDecision, 'deny');
});

test('an ordinary lint run, or the flag quoted inside other text, passes through', () => {
  assert.deepEqual(bash('npx eslint src/app.tsx'), { status: 0, output: null, stderr: '' });
  assert.deepEqual(bash(`git commit -m "explain why eslint ${suppressAll} is denied"`), { status: 0, output: null, stderr: '' });
});

test('a stop with a lint error in a changed file is sent back with the findings', (t) => {
  const dir = checkout(t, { 'changed.js': 'debugger\n' });
  const { status, stderr } = runHook({ hook_event_name: 'Stop', cwd: dir });
  assert.equal(status, 2);
  assert.match(stderr, /changed\.js[\s\S]*no-debugger/);
});

test('a stop with clean changes, or one already answering a block, is let through', (t) => {
  const clean = checkout(t, { 'changed.js': 'export const answer = 42\n' });
  assert.equal(runHook({ hook_event_name: 'Stop', cwd: clean }).status, 0);
  const failing = checkout(t, { 'changed.js': 'debugger\n' });
  assert.equal(runHook({ hook_event_name: 'Stop', cwd: failing, stop_hook_active: true }).status, 0);
});
