import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * PAP-15: the thumb was sized in rem and the track in px, so with the
 * browser's text size at 200% the thumb grew out of the track (Settings, the
 * Privacy popover). The suite has no DOM, so the geometry is worked out from
 * the utilities switch.tsx sets, at the root font size of 100%, 150% and 200%
 * text, and the thumb has to sit inside the track with the same margin on
 * every side, off and on.
 */

const SWITCH = new URL('./switch.tsx', import.meta.url);
// global.css imports Tailwind's theme, where `--spacing` is the step behind `h-5`, `size-4`…
const TAILWIND_THEME = new URL(import.meta.resolve('tailwindcss/theme.css'));

type Length = { rem: number; px: number };

test('the switch thumb stays inside its track, evenly inset, at 100%, 150% and 200% text', async () => {
  const [source, theme] = await Promise.all([readFile(SWITCH, 'utf8'), readFile(TAILWIND_THEME, 'utf8')]);
  const spacing = theme.match(/--spacing:\s*([\d.]+)rem;/);
  assert.ok(spacing, 'tailwindcss/theme.css no longer sets --spacing in rem');
  const root = source.match(/<SwitchPrimitive\.Root[\s\S]*?(?=<SwitchPrimitive\.Thumb)/)?.[0];
  const thumb = source.match(/<SwitchPrimitive\.Thumb[\s\S]*?\/>/)?.[0];
  assert.ok(root && thumb, 'switch.tsx no longer renders a Root around a Thumb');

  const length = (block: string, prefix: string): Length => {
    const escaped = prefix.replace(/[[\]]/g, '\\$&');
    const value = block.match(new RegExp(`(?<=[\\s'"])${escaped}(\\S+?)(?=[\\s'"])`))?.[1];
    assert.ok(value, `switch.tsx sets no ${prefix}…`);
    const arbitrary = value.match(/^\[([\d.]+)(px|rem)\]$/);
    if (arbitrary) return arbitrary[2] === 'px' ? { rem: 0, px: Number(arbitrary[1]) } : { rem: Number(arbitrary[1]), px: 0 };
    assert.match(value, /^[\d.]+$/, `cannot measure ${prefix}${value}`);
    return { rem: Number(value) * Number(spacing[1]), px: 0 };
  };
  // Tailwind's `border` is 1px a side; under border-box it comes out of the declared size.
  const hairlines = /(?<=[\s'"])box-content(?=[\s'"])/.test(root) ? 0 : 2;

  for (const size of ['default', 'sm']) {
    const track = { height: length(root, `data-[size=${size}]:h-`), width: length(root, `data-[size=${size}]:w-`) };
    const knob = length(thumb, `in-data-[size=${size}]:size-`);
    const off = length(thumb, `in-data-[size=${size}]:translate-x-`);
    const on = length(thumb, `in-data-[size=${size}]:data-checked:translate-x-`);
    for (const fontSize of [16, 24, 32]) {
      const px = ({ rem, px: fixed }: Length) => rem * fontSize + fixed;
      const inner = { height: px(track.height) - hairlines, width: px(track.width) - hairlines };
      const margins = {
        top: (inner.height - px(knob)) / 2,
        leftWhenOff: px(off),
        rightWhenOn: inner.width - px(on) - px(knob),
      };
      const at = `${size} switch at ${fontSize}px root text`;
      assert.ok(margins.top > 0, `${at}: the thumb (${px(knob)}px) is taller than the track (${inner.height}px inside)`);
      assert.ok(Math.abs(margins.leftWhenOff - margins.top) < 0.01, `${at}: off, the thumb is ${margins.leftWhenOff}px from the left edge, ${margins.top}px from the top`);
      assert.ok(Math.abs(margins.rightWhenOn - margins.top) < 0.01, `${at}: on, the thumb is ${margins.rightWhenOn}px from the right edge, ${margins.top}px from the top`);
    }
  }
});
