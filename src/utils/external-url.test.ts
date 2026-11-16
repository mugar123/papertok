import assert from 'node:assert/strict';
import test from 'node:test';
import { isTrustedInlinePdfUrl, safeDoiUrl, safeExternalUrl } from './external-url.ts';

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
  // A resolver link is held to the same shape once it is decoded.
  assert.equal(safeDoiUrl('https://doi.org/javascript:alert(1)'), '');
  assert.equal(safeDoiUrl('https://doi.org/10.1234%2F'), '');
});

// A real Wiley DOI (Crossref, 2026-11-16) whose last character is `#`. doi.org
// decodes a link's path once: asked that day through `doi.org/api/handles/`,
// `…3.0.co;2-%23` resolved to Wiley, and `…3.0.co;2-#` was looked up without
// the `#` and not found. The 10.1234 DOIs below are synthetic.
const SICI_DOI = '10.1002/(sici)1097-0282(1996)40:1<1::aid-bip1>3.0.co;2-#';
const SICI_LINK = 'https://doi.org/10.1002/(sici)1097-0282(1996)40:1%3C1::aid-bip1%3E3.0.co;2-%23';

test('a DOI link carries every character of the DOI in its path', () => {
  assert.equal(safeDoiUrl(SICI_DOI), SICI_LINK);
  // OpenAlex writes the DOI behind the resolver, its characters as they are.
  assert.equal(safeDoiUrl(`https://doi.org/${SICI_DOI}`), SICI_LINK);
  assert.equal(safeDoiUrl('10.1234/odd?part#two'), 'https://doi.org/10.1234/odd%3Fpart%23two');
  assert.equal(safeDoiUrl('10.1234/a b"c\\d'), 'https://doi.org/10.1234/a%20b%22c%5Cd');

  // What a browser sends doi.org for each link, decoded once as doi.org does,
  // after the gate `openExternalUrl` puts every link through.
  const dois = [
    SICI_DOI,
    '10.1234/odd?part#two',
    '10.1234/50%off',
    '10.1234/a%3Fb',
    '10.1234/a b"c\\d^e`f{g}h|i[j]k',
    '10.1234/a+b&c=d;e,f:g@h$i',
    '10.1234/análisis-β',
  ];
  for (const doi of dois) {
    const url = new URL(safeExternalUrl(safeDoiUrl(doi)));
    assert.equal(url.origin, 'https://doi.org', doi);
    assert.equal(url.search + url.hash, '', doi);
    assert.equal(decodeURIComponent(url.pathname.slice(1)), doi, doi);
  }
});

test('a `%` is the DOI\'s own in a bare DOI and an escape in a resolver link', () => {
  // The DOI 10.1234/a%3Fb, whose own characters include `%3F`.
  assert.equal(safeDoiUrl('10.1234/a%3Fb'), 'https://doi.org/10.1234/a%253Fb');
  // A link is already percent-encoded: these name 10.1234/a?b.
  assert.equal(safeDoiUrl('https://doi.org/10.1234/a%3Fb'), 'https://doi.org/10.1234/a%3Fb');
  assert.equal(safeDoiUrl('http://dx.doi.org/10.1234%2Fa%3fb'), 'https://doi.org/10.1234/a%3Fb');
  // So the helper's own link comes back unchanged.
  assert.equal(safeDoiUrl(SICI_LINK), SICI_LINK);
  assert.equal(safeDoiUrl('https://doi.org/10.1234/a%253Fb'), 'https://doi.org/10.1234/a%253Fb');
  // A link whose `%` starts no escape is read as written, whole.
  assert.equal(safeDoiUrl('https://doi.org/10.1234/50%off'), 'https://doi.org/10.1234/50%25off');
  assert.equal(safeDoiUrl('https://doi.org/10.1234/a%3Fb%zz'), 'https://doi.org/10.1234/a%253Fb%25zz');
});
