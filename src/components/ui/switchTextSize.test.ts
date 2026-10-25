import test from 'node:test';
import assert from 'node:assert/strict';
import { switchThumb, switchTrack } from './switch-variants.ts';

/**
 * ENG-15: the thumb was sized in rem and the track in px, so with the
 * browser's text size at 200% the thumb grew out of the track (Settings, the
 * Privacy popover). The suite has no DOM, so the geometry is worked out from
 * the utilities the switch carries, at the root font size of 100%, 150% and
 * 200% text, and the thumb has to sit inside the track with the same margin
 * on every side, off and on.
 */

// Tailwind's `--spacing` is 0.25rem: the step behind `h-5`, `size-4`, `translate-x-0.5`…
const SPACING_REM = 0.25;

type Length = { rem: number; px: number };

function length(classes: string[], prefix: string): Length {
  const value = classes.find(name => name.startsWith(prefix))?.slice(prefix.length);
  assert.ok(value, `the switch sets no ${prefix}…`);
  const arbitrary = value.match(/^\[([\d.]+)(px|rem)\]$/);
  if (arbitrary) return arbitrary[2] === 'px' ? { rem: 0, px: Number(arbitrary[1]) } : { rem: Number(arbitrary[1]), px: 0 };
  assert.match(value, /^[\d.]+$/, `cannot measure ${prefix}${value}`);
  return { rem: Number(value) * SPACING_REM, px: 0 };
}

test('the switch thumb stays inside its track, evenly inset, at 100%, 150% and 200% text', () => {
  for (const size of ['default', 'sm'] as const) {
    const root = switchTrack({ size }).split(/\s+/);
    const thumb = switchThumb({ size }).split(/\s+/);
    const track = { height: length(root, 'h-'), width: length(root, 'w-') };
    const knob = length(thumb, 'size-');
    const off = length(thumb, 'translate-x-');
    const on = length(thumb, 'data-checked:translate-x-');
    // Tailwind's `border` is 1px a side; under border-box it comes out of the declared size.
    const hairlines = root.includes('box-content') ? 0 : 2;

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
