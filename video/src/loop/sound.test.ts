import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeWav, renderLoopAudio } from "./sound.ts";

const SR = 16000;
const { left, right } = renderLoopAudio(SR);

test("the track is exactly one loop long", () => {
  assert.equal(left.length, 15 * SR);
  assert.equal(right.length, 15 * SR);
});

test("the track peaks below full scale and is not silent", () => {
  let peak = 0;
  for (let i = 0; i < left.length; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  assert.ok(peak <= 0.9, `peak ${peak}`);
  assert.ok(peak > 0.5, `peak ${peak}`);
});

test("the seam is no sharper than the rest of the track", () => {
  for (const ch of [left, right]) {
    const steps: number[] = [];
    for (let i = 1; i < ch.length; i++) steps.push(Math.abs(ch[i] - ch[i - 1]));
    steps.sort((a, b) => a - b);
    const p99 = steps[Math.floor(steps.length * 0.99)];
    const seam = Math.abs(ch[0] - ch[ch.length - 1]);
    assert.ok(seam <= p99, `seam step ${seam} vs p99 ${p99}`);
  }
});

test("the breath before the first card is quieter than the flood", () => {
  const rms = (from: number, to: number) => {
    let s = 0;
    for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) s += left[i] ** 2;
    return Math.sqrt(s / ((to - from) * SR));
  };
  assert.ok(rms(146 / 60 + 0.01, 150 / 60) < rms(2.1, 2.4) * 0.5);
});

test("the WAV header describes 16-bit stereo PCM", () => {
  const wav = encodeWav(left.subarray(0, 10), right.subarray(0, 10), SR);
  const view = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), "RIFF");
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), SR);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(wav.length, 44 + 10 * 4);
});
