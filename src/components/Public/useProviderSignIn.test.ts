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
    // Always mounted, so its status exists before the wait ends, and after
    // both buttons, so the line it keeps never moves them.
    const note = jsx.indexOf('<PreparingNote id={preparingId} preparing={preparing} />');
    const lastPress = Math.max(...[...jsx.matchAll(/signIn\('(?:google|github)'\)/gi)].map(match => match.index));
    assert.ok(note > lastPress, `${file}: the note follows the buttons`);
  }
});

/**
 * The wait used to be told only to assistive tech, through a hidden
 * description, and its end to nobody. Sighted readers see it under the
 * buttons; a screen reader hears it end, and only a wait that was shown.
 */
test('SOURCE: "Preparing sign-in…" shows under the buttons, and its end is announced once', async () => {
  const parts = await read('./ProviderSignIn.tsx');
  assert.doesNotMatch(parts, /\shidden[\s/>]/, 'no hidden attribute');
  assert.match(parts, /const \[waited\] = useState\(preparing\);/, 'a note that mounted ready never announces');
  assert.match(parts, /<p id=\{id\} role="status" className=\{waited \? 'provider-preparing' : 'sr-only'\}>/);
  assert.match(parts, /\{preparing \? 'Preparing sign-in…' : waited && <span className="sr-only">Sign-in ready\.<\/span>\}/);

  const css = await readFile(new URL('./ProviderSignIn.css', import.meta.url), 'utf8');
  const rule = css.match(/\.provider-preparing \{([^}]*)\}/)?.[1] ?? '';
  assert.match(rule, /min-height: calc\(var\(--fs-xs\) \* var\(--lh-normal\)\);/, 'the line stays once the text goes');
  assert.match(rule, /color: var\(--text-tertiary\);/);
  assert.match(rule, /font-size: var\(--fs-xs\);/);

  // The welcome's reveal sets its rows to full opacity in an unlayered sheet,
  // which would beat the Button's disabled look in its utility layer.
  const welcome = await readFile(new URL('./GuestWelcome.css', import.meta.url), 'utf8');
  assert.match(welcome, /\.gw-providers\[data-open\] > div > \[data-disabled\] \{\s*opacity: revert-layer;\s*\}/);
});
