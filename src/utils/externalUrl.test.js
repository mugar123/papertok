import assert from 'node:assert/strict';
import test from 'node:test';
import { isTrustedInlinePdfUrl, safeDoiUrl, safeExternalUrl } from './externalUrl.js';

test('accepts only credential-free HTTPS external URLs', () => {
  assert.equal(safeExternalUrl('https://example.org/paper'), 'https://example.org/paper');
  assert.equal(safeExternalUrl('javascript:alert(1)'), '');
  assert.equal(safeExternalUrl('http://example.org/paper'), '');
  assert.equal(safeExternalUrl('https://user:secret@example.org/paper'), '');
});

// La lista no dice «académico», dice «se deja enmarcar». Comprobado con
// cabeceras reales el 2026-08-29: arXiv sirve el PDF sin `X-Frame-Options`,
// mientras que `pmc.ncbi.nlm.nih.gov` y `europepmc.org` responden
// `X-Frame-Options: DENY` (PMC además redirige su `/pdf/` a HTML) y
// `www.ebi.ac.uk` es la API REST, que devuelve XML y no tiene PDF que servir.
// Enmarcar a los tres daba un recuadro gris, no un artículo.
test('allows inline PDFs only from hosts that permit framing', () => {
  assert.equal(isTrustedInlinePdfUrl('https://arxiv.org/pdf/2601.00001'), true);
  assert.equal(isTrustedInlinePdfUrl('https://export.arxiv.org/pdf/2601.00001'), true);
  assert.equal(isTrustedInlinePdfUrl('https://pmc.ncbi.nlm.nih.gov/articles/PMC1/pdf/'), false);
  assert.equal(isTrustedInlinePdfUrl('https://europepmc.org/articles/PMC1?pdf=render'), false);
  assert.equal(isTrustedInlinePdfUrl('https://www.ebi.ac.uk/europepmc/webservices/rest/PMC1/fullTextXML'), false);
  assert.equal(isTrustedInlinePdfUrl('https://attacker.example/paper.pdf'), false);
  assert.equal(isTrustedInlinePdfUrl('https://arxiv.org.attacker.example/paper.pdf'), false);
});

test('builds DOI links only from DOI-shaped identifiers', () => {
  assert.equal(safeDoiUrl('10.1000/example'), 'https://doi.org/10.1000/example');
  assert.equal(safeDoiUrl('javascript:alert(1)'), '');
});
