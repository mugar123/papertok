import { test } from "node:test";
import assert from "node:assert/strict";
import { BEAT, CAPTION_EXIT, CAPTIONS, FPS, SWIPE_DURATIONS, T, TOTAL } from "./timeline.ts";
import { trackPosition } from "./motion.ts";
import { PAPERS } from "./papers.ts";

test("the loop lasts 15 seconds on a whole number of beats", () => {
  assert.equal(TOTAL / FPS, 15);
  assert.equal(TOTAL % BEAT, 0);
});

test("every cue falls inside the loop", () => {
  for (const [name, value] of Object.entries(T)) {
    for (const f of [value].flat()) {
      assert.ok(f >= 0 && f < TOTAL, `${name} = ${f}`);
    }
  }
});

test("swipes end before the next one starts and before the next act", () => {
  T.swipes.forEach((start, i) => {
    const end = start + SWIPE_DURATIONS[i];
    const next = T.swipes[i + 1] ?? T.caption4;
    assert.ok(end <= next, `swipe ${i} ends at ${end}, next cue at ${next}`);
  });
});

test("the feed lands on the last paper", () => {
  assert.equal(T.swipes.length, PAPERS.length - 1);
  assert.equal(trackPosition(0), 0);
  assert.ok(Math.abs(trackPosition(T.caption4) - (PAPERS.length - 1)) < 1e-9);
});

test("captions never overlap and each stays on screen long enough to read", () => {
  const sorted = [...CAPTIONS].sort((a, b) => a.in - b.in);
  sorted.forEach((c, i) => {
    assert.ok(c.out - c.in >= 1.5 * FPS, `${c.id} is on screen for ${c.out - c.in} frames`);
    if (i > 0) {
      const prev = sorted[i - 1];
      assert.ok(c.in >= prev.out + CAPTION_EXIT, `${c.id} starts before ${prev.id} has left`);
    }
  });
});

test("papers carry stable identifiers", () => {
  const ids = PAPERS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^(arxiv|doi):/);
});
