import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * En táctil, el PDF embebido está roto por plataforma: iOS Safari pinta solo
 * la PRIMERA página dentro de un iframe (visto en un iPhone real, 2026-08-29)
 * y Android Chrome no lo renderiza. El visor traspasa al visor nativo del
 * navegador en una pestaña nueva en vez de fingir.
 */
test('el visor no monta el iframe en puntero grueso: traspasa al visor nativo', async () => {
  const source = await readFile(new URL('./PDFViewer.jsx', import.meta.url), 'utf8');
  // El iframe cuelga de canEmbed, y canEmbed excluye el puntero grueso.
  assert.match(source, /const canEmbed = Boolean\(pdfUrl\) && !coarsePointer;/);
  assert.match(source, /\{canEmbed && <iframe/);
  // La tarjeta de traspaso existe y solo cuando hay PDF que traspasar…
  assert.match(source, /\{pdfUrl && coarsePointer && \(/);
  // …y el fallback de «no hay PDF» sigue llegando al táctil sin PDF.
  assert.match(source, /shouldShowFallback && !\(coarsePointer && pdfUrl\)/);
});

test('la tarjeta de traspaso tiene superficie propia y un botón legible', async () => {
  const css = await readFile(new URL('./PDFViewer.css', import.meta.url), 'utf8');
  const card = css.match(/\.pdf-fallback\s*\{[^}]*\}/);
  assert.ok(card, 'PDFViewer.css perdió .pdf-fallback');
  // Sin superficie, el mensaje flotaba desnudo sobre el contenido oscurecido.
  assert.match(card[0], /background:\s*var\(--bg-card\)/);
  const link = css.match(/\.pdf-fallback-link\s*\{[^}]*\}/);
  assert.ok(link, 'PDFViewer.css perdió .pdf-fallback-link');
  // El par viejo (--gradient-brand + --text-primary) resolvía tinta sobre
  // tinta tras el rediseño claro: un rectángulo negro con texto invisible.
  assert.match(link[0], /background:\s*var\(--accent-primary\)/);
  assert.match(link[0], /color:\s*var\(--text-inverse\)/);
});
