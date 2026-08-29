import { test } from "node:test";
import assert from "node:assert/strict";
import { SCRIPT, TOTAL_FRAMES, startFrameOf } from "./script.ts";

test("la suma de bloques es exactamente la duración de la composición", () => {
  const sum = SCRIPT.reduce((n, b) => n + b.durationInFrames, 0);
  assert.equal(sum, 4920);
  assert.equal(TOTAL_FRAMES, 4920);
});

test("ningún bloque dura cero o menos", () => {
  for (const b of SCRIPT) {
    assert.ok(b.durationInFrames > 0, `${b.id} dura ${b.durationInFrames}`);
  }
});

test("los identificadores no se repiten", () => {
  const ids = SCRIPT.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("toda cartela lleva texto, y su palabra destacada aparece en el texto", () => {
  for (const b of SCRIPT.filter((b) => b.kind === "card")) {
    assert.ok(b.text, `${b.id} sin texto`);
    assert.ok(b.highlight, `${b.id} sin palabra destacada`);
    assert.ok(
      b.text!.includes(b.highlight!),
      `${b.id}: "${b.highlight}" no aparece en "${b.text}"`
    );
  }
});

test("startFrameOf devuelve el acumulado y 0 para el primero", () => {
  assert.equal(startFrameOf(SCRIPT[0].id), 0);
  assert.equal(startFrameOf(SCRIPT[1].id), SCRIPT[0].durationInFrames);
});
