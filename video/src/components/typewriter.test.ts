import { test } from "node:test";
import assert from "node:assert/strict";
import { charsVisible } from "./typewriter-core.ts";

test("antes del retardo no se ve nada", () => {
  assert.equal(charsVisible(5, 20, 1, 30), 0);
});

test("en el fotograma del retardo empieza en cero", () => {
  assert.equal(charsVisible(30, 20, 1, 30), 0);
});

test("avanza al ritmo indicado", () => {
  assert.equal(charsVisible(40, 20, 1, 30), 10);
  assert.equal(charsVisible(40, 20, 2, 30), 20);
});

test("nunca pasa del total", () => {
  assert.equal(charsVisible(9999, 20, 1, 30), 20);
});

test("no devuelve fracciones", () => {
  assert.equal(charsVisible(35, 20, 0.5, 30), 2);
});
