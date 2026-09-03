import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * La ronda del iPhone del 2026-08-29, capítulo paleta de búsqueda: abrirla
 * hacía zoom a toda la página (input a 15px, bajo el umbral de iOS) y el
 * diálogo aparecía y se iba en un frame (solo el velo tenía fundido).
 */

const DIALOG_JSX = new URL('./dialog.jsx', import.meta.url);
const COMMAND_JSX = new URL('./command.jsx', import.meta.url);
const VARIABLES_CSS = new URL('../../styles/variables.css', import.meta.url);

test('el input de la paleta no puede volver a disparar el auto-zoom de iOS', async () => {
  const command = await readFile(COMMAND_JSX, 'utf8');
  const input = command.match(/CommandPrimitive\.Input[\s\S]*?\{\.\.\.props\}/);
  assert.ok(input, 'command.jsx ya no renderiza CommandPrimitive.Input');
  assert.match(input[0], /text-\[1rem\]|text-base/);
  assert.doesNotMatch(input[0], /text-\[0\.\d+rem\]|text-sm(?![\w-])/);
});

test('el contenido del diálogo anima entrada y salida, no solo el velo', async () => {
  const dialog = await readFile(DIALOG_JSX, 'utf8');
  const content = dialog.match(/function DialogContent[\s\S]*?\n\}/);
  assert.ok(content, 'dialog.jsx ya no define DialogContent');
  assert.match(content[0], /data-\[state=open\]:\[animation:dialogIn/);
  // `both` es el contrato con radix-Presence: sin él, el unmount corta la
  // salida y volvemos a la desaparición en un frame.
  assert.match(content[0], /data-\[state=closed\]:\[animation:dialogOut[^\]]*_both\]/);

  const variables = await readFile(VARIABLES_CSS, 'utf8');
  for (const name of ['dialogIn', 'dialogOut']) {
    const frames = variables.match(new RegExp(`@keyframes ${name}\\s*\\{[\\s\\S]*?\\n\\}`));
    assert.ok(frames, `variables.css perdió @keyframes ${name}`);
    // scale nativo, nunca transform/translate: Tailwind v4 centra el diálogo
    // con la propiedad translate y un keyframe que la toque lo descoloca
    // durante toda la animación.
    assert.doesNotMatch(frames[0], /transform|translate/);
  }
});

test('el filete de foco del campo no toca la primera letra', async () => {
  const command = await readFile(COMMAND_JSX, 'utf8');
  const input = command.match(/CommandPrimitive\.Input[\s\S]*?\{\.\.\.props\}/);
  assert.ok(input, 'command.jsx ya no renderiza CommandPrimitive.Input');
  // global.css dibuja el indicador de foco de los campos de texto como
  // `inset 0 0 0 1px`: un filete justo por dentro de la caja. Con `px-0` el
  // borde de la caja es el borde de la primera letra, y el anillo se leía como
  // superpuesto a la «S» del placeholder (usuario, 2026-09-03).
  assert.doesNotMatch(input[0], /\bpx-0\b/, 'el campo vuelve a pegar el filete al texto');
  assert.match(input[0], /\bpx-(?:[2-9]|\d{2}|\d+\.5)\b/, 'el campo necesita padding horizontal');
});
