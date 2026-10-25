// Claude Code hooks for this repository (.claude/settings.json).
//
// PreToolUse stops an agent from recording ESLint findings as suppressions,
// which AGENTS.md says it must repair instead. Stop runs ESLint on the files
// changed on the branch and in the working tree, and sends the findings back
// before the agent can finish. Edits to the files that define the checks are
// gated by `permissions.ask` in the same settings file.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type HookInput = {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { command?: string };
  stop_hook_active?: boolean;
  cwd?: string;
};

// An eslint command (not text that mentions one) that records findings
// instead of reporting them.
const SUPPRESSION = /(^|[;&|]\s*)(npx\s+(-\S+\s+)*)?eslint\b[^\n;&|]*\s--suppress-(all|rule)\b/;
const LINTED = /\.(ts|tsx|js|jsx|mjs|css)$/;

function git(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// The checkout the session works in. CLAUDE_PROJECT_DIR stays on the main
// checkout when a session enters a worktree; the input's cwd follows it.
function checkoutRoot(input: HookInput) {
  const cwd = input.cwd || process.cwd();
  try {
    return git(cwd, 'rev-parse', '--show-toplevel');
  } catch {
    return process.env.CLAUDE_PROJECT_DIR || cwd;
  }
}

function changedFiles(root: string) {
  let base = 'HEAD';
  try {
    base = git(root, 'merge-base', 'HEAD', 'origin/main');
  } catch {
    // No origin/main (a fresh clone of a fork, say): the working tree alone.
  }
  const names = [
    ...git(root, 'diff', '--name-only', base).split('\n'),
    ...git(root, 'ls-files', '--others', '--exclude-standard').split('\n'),
  ];
  return [...new Set(names)].filter(path => LINTED.test(path) && existsSync(resolve(root, path)));
}

function stopCheck(input: HookInput) {
  // The agent is already answering a previous block; let it stop.
  if (input.stop_hook_active) return 0;
  const root = checkoutRoot(input);
  const files = changedFiles(root);
  if (files.length === 0) return 0;
  if (!existsSync(resolve(root, 'worker-configuration.d.ts'))) {
    spawnSync('npx', ['--no-install', 'wrangler', 'types'], { cwd: root, stdio: 'ignore' });
  }
  const lint = spawnSync('npx', ['--no-install', 'eslint', '--flag', 'unstable_native_nodejs_ts_config', '--no-warn-ignored', ...files], {
    cwd: root,
    encoding: 'utf8',
  });
  if (lint.status === 0) return 0;
  if (lint.status === null || lint.error) {
    process.stderr.write(`The lint check could not run (${lint.error?.message ?? `signal ${lint.signal}`}). Run \`npm ci\` and \`npm run lint\`.\n`);
    return 2;
  }
  process.stderr.write(`ESLint reports problems in the files changed on this branch. Fix them at their cause:\n${lint.stdout}${lint.stderr}`);
  return 2;
}

export function preToolUseDecision(input: HookInput) {
  const command = input.tool_input?.command;
  if (input.tool_name !== 'Bash' || !command || !SUPPRESSION.test(command)) return null;
  return { decision: 'deny', reason: 'ESLint findings are fixed, not recorded as suppressions (AGENTS.md).' };
}

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}') as HookInput;
  if (input.hook_event_name === 'Stop') {
    process.exitCode = stopCheck(input);
    return;
  }
  const decision = preToolUseDecision(input);
  if (!decision) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.decision,
      permissionDecisionReason: decision.reason,
    },
  }));
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
