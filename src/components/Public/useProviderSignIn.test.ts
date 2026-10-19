import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')
  .then(source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));

/**
 * A Google or GitHub window opened after its scripts finish loading can land
 * outside the press, where Safari blocks it (popupRedirectResolver.ts). Both
 * places with the two buttons, the sign-in dialog and the welcome, disable
 * them until the window can open inside the press, keep them focusable and
 * describe them as preparing.
 */
test('SOURCE: the provider buttons stay disabled but focusable until the window can open inside the press', async () => {
  const hook = await read('./useProviderSignIn.ts');
  assert.match(hook, /const preparing = !usePopupReady\(popupReadiness\);/);
  assert.match(hook, /return \{[^}]*\bpreparing\b[^}]*\};/);

  for (const file of ['./SignInMethods.tsx', './GuestWelcome.tsx']) {
    const jsx = await read(file);
    const buttons = [...jsx.matchAll(/<Button\b(?:(?!<Button\b)[\s\S])*?\n\s*>\n/g)]
      .map(([button]) => button)
      .filter(button => /signIn\('(?:google|github)'\)/i.test(button));
    assert.equal(buttons.length, 2, `${file}: a button per provider`);
    for (const button of buttons) {
      assert.match(button, /disabled=\{preparing\}/, file);
      assert.match(button, /focusableWhenDisabled\b/, `${file}: a disabled provider keeps focus`);
      assert.match(button, /aria-describedby=\{preparing \? preparingId : undefined\}/, file);
    }
    assert.match(jsx, /preparing \|\| pendingProvider === 'google' \?/, `${file}: the spinner shows while preparing`);
    assert.match(jsx, /preparing \|\| pendingProvider === 'github' \?/, `${file}: the spinner shows while preparing`);
    assert.match(jsx, /\{preparing && <PreparingNote id=\{preparingId\} \/>\}/, file);
  }

  const parts = await read('./ProviderSignIn.tsx');
  assert.match(parts, /<span id=\{id\} hidden>Preparing sign-in…<\/span>/);
});
