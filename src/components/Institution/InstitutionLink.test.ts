import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string|URL) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('SOURCE: the link form keeps its own Google button unless the caller draws the submit', async () => {
  const code = stripComments(await read('./InstitutionLink.tsx'));
  // Settings passes neither, so it keeps the button and its own address.
  assert.match(code, /formId,\s*showSubmit = true,\s*email: controlledEmail,\s*onEmailChange,\s*onBusyChange,\s*linkedNote,/);
  assert.match(code, /\{COPY\.linked\(institution\.name\)\}\{linkedNote \? ` \$\{linkedNote\}` : ''\}/);
  assert.match(code, /<form id=\{formId\} className="institution-link" onSubmit=\{handleSubmit\}/);
  assert.match(
    code,
    /\{showSubmit && \(\s*<Button\s+type="submit"\s+variant="outline"\s+className="institution-link-submit"[\s\S]*?COPY\.submit\}\s*<\/Button>\s*\)\}/,
  );
  // Uncontrolled and empty by default; controlled when the caller passes
  // `email`, and then every write goes through the caller.
  assert.match(code, /const \[ownEmail, setOwnEmail\] = useState(?:<[^;\n]+>)?\(''\);/);
  assert.match(code, /const email = controlled \? controlledEmail : ownEmail;/);
  assert.match(code, /const setEmail = controlled \? onEmailChange : setOwnEmail;/);
  assert.equal((code.match(/setOwnEmail\(/g) || []).length, 0, 'nothing writes the own copy past the switch');
  assert.match(code, /useEffect\(\(\) => \{ onBusyChange\?\.\(busy\); \}, \[busy, onBusyChange\]\);/);
  // The hint names no button: in the onboarding there is none beside it.
  assert.match(code, /hint: 'When you continue, Google opens so you can sign in with that account\. PaperTok keeps the institution, not the address\.',/);
});

test('SOURCE: Settings opens the link as it always has, with its own button', async () => {
  const dialog = stripComments(await read('./InstitutionDialog.tsx'));
  assert.match(dialog, /<InstitutionLink idPrefix="settings-institution" \/>/);
  assert.doesNotMatch(dialog, /showSubmit|formId|onEmailChange|onBusyChange|linkedNote/);
});

/**
 * The link's Google window opens on a second Auth instance, which loads its
 * own popup scripts. A window opened after that load can land outside the
 * press, where Safari blocks it, so the form waits for that instance.
 */
test('SOURCE: the link form ignores a submit until its window can open inside the press', async () => {
  const code = stripComments(await read('./InstitutionLink.tsx'));
  // Only while the form shows: a linked institution opens no window.
  assert.match(code, /const preparing = !usePopupReady\(institution \? null : institutionLinkReadiness\(\)\);/);
  // Enter in the field and the onboarding's primary submit the form too.
  assert.match(code, /const handleSubmit = async \(event: FormEvent<HTMLFormElement>\) => \{\s*event\.preventDefault\(\);\s*if \(busy \|\| preparing\) return;/);
  const submit = code.match(/<Button\s+type="submit"[\s\S]*?\n\s*>/)?.[0] ?? '';
  // Base UI's disabled state, so it looks disabled too, and still focusable.
  assert.match(submit, /\bdisabled=\{preparing\}\s+focusableWhenDisabled\s/);
  // Replaces Base UI's own aria-disabled, so it has to cover the wait as well.
  assert.match(submit, /aria-disabled=\{busy \|\| preparing \|\| undefined\}/);
  assert.match(submit, /aria-describedby=\{preparing \? preparingId : undefined\}/);
  assert.match(code, /\{busy \|\| preparing \? <span className="institution-link-spinner" aria-hidden="true" \/> : <GoogleMark size=\{16\} \/>\}/);
  // Shown under the field and its button, out of their wrapping row.
  assert.match(code, /<\/div>\s*\{showSubmit && <PreparingNote id=\{preparingId\} preparing=\{preparing\} \/>\}\s*<p id=\{hintId\}/);
});
