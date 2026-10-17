import test from 'node:test';
import assert from 'node:assert/strict';
import { SMILE_EXIT, smileExitFrame, smileExitLayout } from './petriSmileExit.ts';

// Petri's crop (PetriFrame's default viewBox) in the veil's 96-pixel loader.
const VIEWBOX = { x: 14, y: 22, width: 128, height: 124 };
const VEILS = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 390, height: 700 },
};
const restBox = (veil: { width: number; height: number }) => ({ left: veil.width / 2 - 48, top: veil.height / 2 - 120, width: 96, height: 96 });
const flightEnd = SMILE_EXIT.flightStartMs + SMILE_EXIT.flightMs;

// The hole's mouth: two half-ellipses on the line y = yc, read back from the
// clip-path so the test checks what the veil is actually clipped to.
function mouthInHole(hole: string) {
  const [left, yc, a, arch, , , , right, , , depth] = hole.match(/Z M (.*)'\)$/)![1].match(/-?\d+(\.\d+)?(e-?\d+)?/g)!.map(Number);
  return { cx: (left + right) / 2, yc, a, arch, depth };
}
const inside = ({ cx, yc, a, arch, depth }: ReturnType<typeof mouthInHole>, x: number, y: number) =>
  ((x - cx) / a) ** 2 + ((y - yc) / (y < yc ? arch : depth)) ** 2 <= 1;

for (const [name, veil] of Object.entries(VEILS)) {
  test(`${name}: before the flight Petri is drawn where she rests, with no hole in the veil`, () => {
    const layout = smileExitLayout(veil, restBox(veil), VIEWBOX);
    const frame = smileExitFrame(0, layout);
    const [x, y, width, height] = frame.viewBox.split(' ').map(Number);
    // Her crop is 128 × 124 in a 96 × 96 box: 96 × 93, centred vertically.
    const scale = veil.width / width;
    assert.ok(Math.abs(scale - 0.75) < 1e-9);
    assert.ok(Math.abs(veil.height / height - 0.75) < 1e-9);
    assert.ok(Math.abs((VIEWBOX.x - x) * scale - restBox(veil).left) < 1e-6);
    assert.ok(Math.abs((VIEWBOX.y - y) * scale - (restBox(veil).top + 1.5)) < 1e-6);
    assert.equal(frame.hole, null);
    assert.equal(smileExitFrame(SMILE_EXIT.flightStartMs, layout).hole, null);
  });

  test(`${name}: the flight ends the frame the open mouth covers every corner of the veil`, () => {
    const layout = smileExitLayout(veil, restBox(veil), VIEWBOX);
    const corners = [[0, 0], [veil.width, 0], [0, veil.height], [veil.width, veil.height]];

    const end = smileExitFrame(flightEnd, layout);
    assert.equal(end.done, true);
    const open = mouthInHole(end.hole!);
    assert.ok(corners.every(([x, y]) => inside(open, x, y)), 'all four corners are inside the mouth');

    // One frame earlier the veil still shows somewhere: no time is spent with
    // the mouth already past the screen.
    const before = smileExitFrame(flightEnd - 16, layout);
    assert.equal(before.done, false);
    const almost = mouthInHole(before.hole!);
    assert.ok(corners.some(([x, y]) => !inside(almost, x, y)), 'a corner is still outside a frame earlier');
  });
}
