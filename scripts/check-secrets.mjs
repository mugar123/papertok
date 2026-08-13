import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const patterns = [
  { name: 'Google API key', regex: /AIza[0-9A-Za-z_-]{30,}/g },
  { name: 'Resend API key', regex: /\bre_[0-9A-Za-z_-]{20,}\b/g },
  { name: 'Brevo API key', regex: /\bxkeysib-[0-9A-Za-z_-]{40,}\b/g },
  { name: 'Modal credential', regex: /\b(?:wk|ws)-[0-9A-Za-z_-]{16,}\b/g },
  {
    name: 'hard-coded 32-character hexadecimal API credential',
    regex: /\b(?:api[_-]?key|token|secret)\s*[:=]\s*['"][a-f0-9]{32}['"]/gi,
  },
];

const ignoredPaths = new Set(['package-lock.json']);
const publicCredentialAllowlist = new Map([
  ['src/services/firebase.js', new Set(['Google API key'])],
  ['wrangler.toml', new Set(['Google API key'])],
]);
const candidateFiles = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean)
  .filter((path) => !ignoredPaths.has(path));

const findings = [];
for (const path of candidateFiles) {
  let contents;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    continue;
  }

  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    if (
      pattern.regex.test(contents)
      && !publicCredentialAllowlist.get(path)?.has(pattern.name)
    ) {
      findings.push(`${path}: ${pattern.name}`);
    }
  }
}

if (findings.length > 0) {
  console.error('Potential secrets detected in tracked files:');
  findings.forEach((finding) => console.error(`- ${finding}`));
  process.exit(1);
}

console.log(`Secret scan passed (${candidateFiles.length} tracked and untracked files).`);
