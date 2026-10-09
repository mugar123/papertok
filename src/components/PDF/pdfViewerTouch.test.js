import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Sin comentarios: un test de fuente no debe aprobar porque un comentario
// cite el código que pide.
const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/**
 * En táctil, el PDF enmarcado está roto por plataforma: iOS Safari pinta solo
 * la PRIMERA página dentro de un iframe (visto en un iPhone real, 2026-08-29)
 * y Android Chrome no lo renderiza. Desde el 2026-10-09 el visor dibuja las
 * páginas él mismo con pdf.js, desde el reenvío del Worker, y solo traspasa al
 * visor del navegador lo que no puede dibujar.
 */
test('el visor no monta el iframe en puntero grueso: dibuja las páginas con pdf.js', async () => {
  const source = stripComments(await readFile(new URL('./PDFViewer.jsx', import.meta.url), 'utf8'));
  assert.match(source, /const canEmbed = Boolean\(pdfUrl\) && !coarsePointer;/);
  assert.match(source, /\{canEmbed && <iframe/);
  assert.match(source, /const relayUrl = coarsePointer \? pdfRelayUrl\(relaySourceUrl, PAPER_API_BASE_URL\) : '';/);
  assert.match(source, /\{drawsPages && \(/);
  assert.match(source, /<PdfPages src=\{relayUrl\}/);
  // pdf.js llega en su propio trozo: un escritorio no lo descarga.
  assert.match(source, /lazy\(\(\) => import\('\.\/PdfPages\.jsx'\)\)/);
  assert.doesNotMatch(source, /^import .*PdfPages/m);
  // Lo que no se puede dibujar sigue teniendo su traspaso, y el «no hay PDF»
  // sigue llegando al táctil sin PDF.
  assert.match(source, /\{coarsePointer && !drawsPages && fullTextUrl && \(/);
  assert.match(source, /shouldShowFallback && !\(coarsePointer && fullTextUrl\)/);
});

test('las páginas usan la build legacy de pdf.js', async () => {
  const source = stripComments(await readFile(new URL('./PdfPages.jsx', import.meta.url), 'utf8'));
  // La moderna llama a Map.getOrInsertComputed y Math.sumPrecise, que los
  // iPhone para los que existe este visor no tienen.
  assert.match(source, /from 'pdfjs-dist\/legacy\/build\/pdf\.min\.mjs'/);
  assert.match(source, /'pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs\?url'/);
  assert.doesNotMatch(source, /from 'pdfjs-dist'/);
  assert.match(source, /isEvalSupported: false/);
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

test('en táctil, abrir un paper monta el visor de la app, sin pestaña nueva', async () => {
  const app = stripComments(await readFile(new URL('../../App.jsx', import.meta.url), 'utf8'));
  assert.match(app, /onOpenPdf=\{openPdf\}/);
  assert.match(app, /const openPdf = setPdfPaper/);
  assert.doesNotMatch(app, /window\.open\(/);
});
