import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string|URL) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('SOURCE: the link form keeps its own submit unless the caller draws the submit', async () => {
  const code = stripComments(await read('./InstitutionLink.tsx'));
  // Settings passes neither, so it keeps the button and its own address.
  assert.match(code, /formId,\s*showSubmit = true,\s*email: controlledEmail,\s*onEmailChange,\s*onBusyChange,\s*linkedNote,/);
  assert.match(code, /\{COPY\.linked\(institution\.name\)\}\{linkedNote \? ` \$\{linkedNote\}` : ''\}/);
  assert.match(code, /<form id=\{formId\} className="institution-link" onSubmit=\{handleSubmit\}/);
  assert.match(
    code,
    /\{showSubmit && \(\s*<Button\s+type="submit"[\s\S]*?aria-label=\{busy \? COPY\.submitting : COPY\.submit\}[\s\S]*?<\/Button>\s*\)\}/,
  );
  // Uncontrolled and empty by default; controlled when the caller passes
  // `email`, and then every write goes through the caller.
  assert.match(code, /const \[ownEmail, setOwnEmail\] = useState(?:<[^;\n]+>)?\(''\);/);
  assert.match(code, /const email = controlled \? controlledEmail : ownEmail;/);
  assert.match(code, /const setEmail = controlled \? onEmailChange : setOwnEmail;/);
  assert.equal((code.match(/setOwnEmail\(/g) || []).length, 0, 'nothing writes the own copy past the switch');
  assert.match(code, /const setBusy = \(next: boolean\) => \{ setOwnBusy\(next\); onBusyChange\?\.\(next\); \};/);
});

test('SOURCE: Settings opens the link as it always has, with its own button', async () => {
  const dialog = stripComments(await read('./InstitutionDialog.tsx'));
  assert.match(dialog, /<InstitutionLink idPrefix="settings-institution" \/>/);
  assert.doesNotMatch(dialog, /showSubmit|formId|onEmailChange|onBusyChange|linkedNote/);
});
