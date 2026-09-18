import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * How the guest's one question arrives, on a phone.
 *
 * The Dialog primitive centres its sheet and brings it in with `dialogIn` —
 * opacity and a 3% scale in 180ms — which is the right arrival for a centred
 * modal. Below 640px this sheet is not centred: it docks to the bottom edge
 * (`top: auto; bottom: 0; translate: -50% 0`), and a sheet anchored to the
 * bottom that appears by shrinking in place does not read as arriving, it
 * reads as having been there already.
 *
 * Measured against production on 2026-09-18, fresh profile, 390px: opacity
 * 0 → 1 and scale 0.97 → 1 in ~120ms with `translate` pinned at `-50%` — not
 * one pixel of vertical travel. After the fix, the same probe walks
 * `-50% 100%` → `90%` → `78%` → `64%` → … → `-50% 0`, and at 700px the sheet
 * still holds `-50% -50%` throughout with its scale, which is the control:
 * a fix that also moved the desktop sheet would be scoped wrong.
 */
const css = readFileSync(new URL('./GuestInterestsPrompt.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

test('on a phone the sheet slides in from the edge it is docked to', () => {
  const bloque = css.match(/@media \(max-width: 639\.98px\)[^{]*\{([\s\S]*?)\n\}/);
  assert.ok(bloque, 'the phone-only arrival is gone: the sheet is back to the centred modal’s entrance');
  assert.match(bloque[1], /\.gip[^{]*\[data-open\][^{]*\{[^}]*animation: gipSlideIn/, 'nothing overrides the primitive’s entrance');
  assert.match(bloque[1], /\[data-closed\][^{]*\{[^}]*animation: gipSlideOut/, 'the leave does not mirror the arrival');

  // Scoped to reduced motion, like every other arrival in this codebase.
  assert.match(bloque[0], /prefers-reduced-motion: no-preference/, 'the slide ignores a reader who asked for less motion');
});

test('the slide keeps the sheet centred on the axis it is not travelling', () => {
  // The trap `variables.css` warns about on `dialogIn`: the sheet is positioned
  // with the native `translate`, so a keyframe that touches it takes the
  // centring with it for as long as it runs — the sheet would jump to the left
  // edge mid-animation. The only way not to take it is to write it in.
  // Hasta la llave de cierre a principio de línea, no hasta la primera: la
  // primera cierra el `from` y deja el `to` fuera de la medida.
  const dentro = css.match(/@keyframes gipSlideIn \{([\s\S]*?)\n\}/);
  const fuera = css.match(/@keyframes gipSlideOut \{([\s\S]*?)\n\}/);
  assert.ok(dentro && fuera, 'the slide keyframes are gone');
  for (const [nombre, k] of [['gipSlideIn', dentro[1]], ['gipSlideOut', fuera[1]]]) {
    const pasos = [...k.matchAll(/translate: ([^;]+);/g)].map((m) => m[1].trim());
    assert.equal(pasos.length, 2, `${nombre} does not name translate at both ends`);
    for (const paso of pasos) {
      assert.match(paso, /^-50% /, `${nombre} drops the horizontal centring at "${paso}": the sheet jumps to the left edge`);
    }
    assert.ok(
      pasos.some((p) => /100%/.test(p)) && pasos.some((p) => /-50% 0$/.test(p)),
      `${nombre} does not travel between the edge and its resting place`,
    );
  }
});

test('the sheet still mounts open, and that is not the bug', () => {
  // Worth writing down because it is the wrong turn this codebase has taken
  // twice: a Base UI popup that mounts already open skips its arrival, and the
  // fix is `usePopupOpenOnMount` (the comments sheet and the follow sheet both
  // needed it). Measured here: this sheet DOES animate on mount — the primitive
  // plays `dialogIn` — so swapping in the hook would move the focus and the
  // `onOpenChangeComplete` handshake for nothing. What was missing was the
  // direction of the motion, not the motion.
  const jsx = readFileSync(new URL('./GuestInterestsPrompt.jsx', import.meta.url), 'utf8');
  assert.match(jsx, /useState\(true\)/, 'if this sheet stops mounting open, check its arrival still plays');
  assert.doesNotMatch(jsx, /usePopupOpenOnMount/);
});
