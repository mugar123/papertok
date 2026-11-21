// Requires documentation impact, verification and review evidence in the
// description (.github/pull_request_template.md). Runs from
// the base branch (.github/workflows/pr-body.yml), so a pull request cannot
// change the check that judges it.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_SECTIONS = ['Documentation', 'Verification', 'Review'];

function sectionText(body: string, heading: string) {
  const lines = body.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^ {0,3}((`|~)\2{2,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1\2*[ \t\r]*$|$(?![\s\S]))/gm, '')
    .split(/\r?\n/);
  const start = lines.findIndex(line => !/^ {4}|^\t/.test(line) && line.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && /^ {0,3}#{1,2}\s/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end)
    // An empty table row or the table's header and separator say nothing.
    .filter(line => !/^\s*\|[\s|:-]*\|\s*$/.test(line) && !/^\s*\|\s*Check or interaction\s*\|/.test(line))
    .join('\n')
    .trimEnd();
}

export function prBodyProblems(body: string, changedFiles: string[] = []) {
  const problems = REQUIRED_SECTIONS.flatMap((heading) => {
    const text = sectionText(body, heading);
    if (text === null) return [`The description has no "## ${heading}" section.`];
    if (heading === 'Documentation') {
      if (!text || !/^(?:Updated|Not needed):[\t ]*\S/m.test(text)) {
        return ['"## Documentation" must state "Updated: <documents and changes>" or "Not needed: <reason>". See ARCHITECTURE.md for documentation owners.'];
      }
    } else if (!text) return [`"## ${heading}" is empty. State what was actually run or done, not what was planned.`];
    return [];
  });
  const production = sectionText(body, 'Production') ?? '';
  for (const [file, change] of [['firestore.rules', 'rules'], ['firestore.indexes.json', 'indexes']]) {
    const instruction = `Deploy Firestore ${change} before the web merge.`;
    if (changedFiles.includes(file) && !production.split('\n').some(line =>
      !/^(?: {4}|\t)/.test(line) && line.trim().replace(/^-\s+/, '').toLowerCase() === instruction.toLowerCase())) {
      problems.push(`Changes to ${file} require this line in "## Production": ${instruction}`);
    }
  }
  return problems;
}

function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8')) as {
    pull_request?: { body?: string | null };
  };
  const pages = JSON.parse(readFileSync(process.argv[2], 'utf8')) as { filename: string; previous_filename?: string }[][];
  const files = pages.flat().flatMap(({ filename, previous_filename }) =>
    previous_filename ? [filename, previous_filename] : [filename]);
  const problems = prBodyProblems(event.pull_request?.body ?? '', files);
  for (const problem of problems) console.log(`::error title=Pull request description::${problem}`);
  if (problems.length) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
