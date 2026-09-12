import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reviewStatusForPaper,
  accessStatusForPaper,
  reviewTagForPaper,
  accessTagForPaper,
} from './paperStatus.js';

test('either field naming a preprint makes it one', () => {
  assert.equal(reviewStatusForPaper({ publicationStatus: 'preprint' }), 'preprint');
  assert.equal(reviewStatusForPaper({ publicationType: 'preprint' }), 'preprint');
});

test('a work typed as an article can still be an unpublished preprint', () => {
  // The divergence that made the card and the report disagree. OpenAlex fills
  // `publicationStatus` from whether any location claims to be published, so a
  // work typed `article` whose only copy is a preprint server reads as one
  // here; the card, testing `publicationType` alone, called it Verified.
  assert.equal(
    reviewStatusForPaper({ type: 'article', publicationType: 'article', publicationStatus: 'preprint' }),
    'preprint',
  );
});

test('a journal is enough to call a paper reviewed', () => {
  assert.equal(reviewStatusForPaper({ journal: 'Nature' }), 'verified');
  assert.equal(reviewStatusForPaper({ publicationStatus: 'published' }), 'verified');
});

test('an empty record claims nothing about peer review', () => {
  // Verified is the reassuring direction, so it is the worse one to guess wrong
  // in: a paper we know nothing about must not be given a badge saying it was
  // reviewed.
  assert.equal(reviewStatusForPaper({}), null);
  assert.equal(reviewStatusForPaper(null), null);
  assert.equal(reviewTagForPaper({}), null);
});

test('an explicit peerReviewed:false is never Verified, whatever the publication fields say', () => {
  // A record that states it was NOT reviewed is the strongest evidence there
  // is, and it was the one field the label ignored: a technical report typed
  // and published, or anything carrying a journal name, came out `verified`
  // over the top of its own denial.
  assert.equal(
    reviewStatusForPaper({ publicationStatus: 'published', publicationType: 'techreport', peerReviewed: false }),
    null,
  );
  assert.equal(reviewStatusForPaper({ journal: 'Some Journal', peerReviewed: false }), null);
});

test('an arXiv copy outranks a publisher that says the paper is closed', () => {
  // OpenAlex reports `is_oa` for the published version. A paper that ran in a
  // subscription journal reads as closed there while its arXiv copy sits free,
  // and the card links that copy — the chip must not contradict the button
  // underneath it.
  assert.equal(accessStatusForPaper({ openAccess: false, arxivId: '2401.00001' }), 'open');
});

test('only an explicit false is a paywall', () => {
  assert.equal(accessStatusForPaper({ openAccess: false }), 'subscription');
  assert.equal(accessStatusForPaper({}), null);
  assert.equal(accessStatusForPaper({ openAccess: undefined, title: 'x' }), null);
  assert.equal(accessTagForPaper({}), null);
});

test('a located free copy opens a paper the record called closed', () => {
  assert.equal(accessStatusForPaper({ openAccess: false }, { openCopyFound: true }), 'open');
});

test('a found copy is a weaker claim than open access, and says so', () => {
  const found = accessTagForPaper({ openAccess: false }, { openCopyFound: true, english: true });
  const native = accessTagForPaper({ openAccess: true }, { english: true });
  assert.equal(found.label, 'Open version');
  assert.equal(native.label, 'Open access');
  assert.notEqual(found.key, native.key);
  assert.equal(found.tone, native.tone);
});

test('a downloadable pdf counts as open', () => {
  // `Paper.js`: "Enlace directo al PDF si existe y es Open Access".
  assert.equal(accessStatusForPaper({ pdfUrl: 'https://example.org/a.pdf' }), 'open');
  assert.equal(accessStatusForPaper({ openAccessPdfUrl: 'https://example.org/a.pdf' }), 'open');
});

test('every chip carries a tone, a word and an explanation, in both languages', () => {
  const papers = [
    { publicationType: 'preprint', arxivId: '2401.00001' },
    { journal: 'Nature', openAccess: false },
  ];
  for (const paper of papers) {
    for (const english of [true, false]) {
      // `reviewTagForPaper` puede no dar nada: desde el 12-09-2026 sólo hay
      // distintivo para el preprint, la salvedad. Lo revisado por pares es la
      // norma y no se señala.
      for (const tag of [reviewTagForPaper(paper, { english }), accessTagForPaper(paper, { english })].filter(Boolean)) {
        assert.match(tag.tone, /^(amber|blue|green|neutral)$/);
        assert.ok(tag.label.length > 0 && tag.hint.length > 0);
      }
    }
  }
});

test('the words differ by language where the term does', () => {
  // "Preprint" is the term in both; "Suscripción" is not.
  assert.equal(reviewTagForPaper({ publicationType: 'preprint' }, { english: false }).label, 'Preprint');
  assert.equal(accessTagForPaper({ openAccess: false }, { english: false }).label, 'Suscripción');
  assert.equal(reviewTagForPaper({ journal: 'Nature' }, { english: false }), null,
    'lo revisado por pares no lleva distintivo: era la norma, no la excepción');
});

/**
 * El sello azul «Verificado» se retiró el 12-09-2026 de las tres superficies
 * que lo pintaban: la fila del explorador, la tarjeta del feed y la portada
 * del informe. El ESTADO sigue calculándose —los filtros lo usan— pero no
 * hay distintivo detrás de él.
 */
test('sólo el preprint lleva distintivo; lo revisado por pares no', () => {
  for (const english of [true, false]) {
    assert.equal(reviewTagForPaper({ journal: 'Nature' }, { english }), null);
    assert.equal(reviewTagForPaper({ publicationStatus: 'published' }, { english }), null);
    const preprint = reviewTagForPaper({ publicationType: 'preprint' }, { english });
    assert.ok(preprint && preprint.key === 'preprint', 'la salvedad sí se señala');
  }
  assert.equal(reviewStatusForPaper({ journal: 'Nature' }), 'verified',
    'el hecho del registro no cambia, sólo deja de pintarse');
});

test('SOURCE: no queda ningún glifo de verificado en las superficies', async () => {
  const { readFile } = await import('node:fs/promises');
  const leer = (ruta) => readFile(new URL(ruta, import.meta.url), 'utf8');
  const sinComentarios = (x) => x.replace(/\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\}|\/\/.*$/gm, '');

  for (const ruta of ['../components/Feed/PaperCard.jsx', '../components/Report/ScientificReport.jsx']) {
    const src = sinComentarios(await leer(ruta));
    assert.doesNotMatch(src, /verified:\s*BadgeCheck/, `${ruta}: glifo muerto`);
    assert.doesNotMatch(src, /BadgeCheck/, `${ruta}: el icono ya no hace falta`);
  }
  const explorer = sinComentarios(await leer('../components/Explorer/EntityExplorer.jsx'));
  assert.doesNotMatch(explorer, /eli-verified|paper\.peerReviewed && \(/,
    'la fila del explorador ya no pinta el sello');
  const css = await leer('../components/Explorer/EntityExplorer.css');
  assert.doesNotMatch(css, /\.eli-verified/, 'ni queda su regla de estilo');
});
