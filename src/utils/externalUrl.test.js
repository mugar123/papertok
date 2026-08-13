import assert from 'node:assert/strict';
import test from 'node:test';
import { isTrustedInlinePdfUrl, safeDoiUrl, safeExternalUrl } from './externalUrl.js';

test('accepts only credential-free HTTPS external URLs', () => {
  assert.equal(safeExternalUrl('https://example.org/paper'), 'https://example.org/paper');
  assert.equal(safeExternalUrl('javascript:alert(1)'), '');
  assert.equal(safeExternalUrl('http://example.org/paper'), '');
  assert.equal(safeExternalUrl('https://user:secret@example.org/paper'), '');
});

test('allows inline PDFs only from explicit academic hosts', () => {
  assert.equal(isTrustedInlinePdfUrl('https://arxiv.org/pdf/2601.00001'), true);
  assert.equal(isTrustedInlinePdfUrl('https://pmc.ncbi.nlm.nih.gov/articles/PMC1/pdf/'), true);
  assert.equal(isTrustedInlinePdfUrl('https://attacker.example/paper.pdf'), false);
  assert.equal(isTrustedInlinePdfUrl('https://arxiv.org.attacker.example/paper.pdf'), false);
});

test('builds DOI links only from DOI-shaped identifiers', () => {
  assert.equal(safeDoiUrl('10.1000/example'), 'https://doi.org/10.1000/example');
  assert.equal(safeDoiUrl('javascript:alert(1)'), '');
});
