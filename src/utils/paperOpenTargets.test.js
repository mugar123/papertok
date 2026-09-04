import assert from 'node:assert/strict';
import test from 'node:test';
import { openFirstTarget, openTargetsForPaper, pdfLinksForPaper } from './paperOpenTargets.js';

test('ordena los destinos: la copia abierta manda, y el DOI nunca entra', () => {
  const targets = openTargetsForPaper({
    arxivId: '2101.00001',
    openAccessPdfUrl: 'https://oa.example/paper.pdf',
    landingPageUrl: 'https://publisher.example/paper',
    doi: '10.1000/example',
  }, { pdfUrl: 'https://repository.example/copy.pdf' });

  assert.deepEqual(targets, [
    { mode: 'external', url: 'https://repository.example/copy.pdf' },
    { mode: 'external', url: 'https://oa.example/paper.pdf' },
    { mode: 'inline', url: 'https://arxiv.org/pdf/2101.00001' },
    { mode: 'external', url: 'https://publisher.example/paper' },
  ]);
});

test('descarta los destinos que el navegador no puede abrir', () => {
  const targets = openTargetsForPaper({
    pdfUrl: 'http://repository.example/paper.pdf',
    landingPageUrl: 'https://publisher.example/paper',
  });

  assert.deepEqual(targets, [{ mode: 'external', url: 'https://publisher.example/paper' }]);
});

test('no repite una misma URL que llega por dos campos', () => {
  const targets = openTargetsForPaper({
    openAccessPdfUrl: 'https://oa.example/paper.pdf',
    pdfUrl: 'https://oa.example/paper.pdf',
  });

  assert.deepEqual(targets, [{ mode: 'external', url: 'https://oa.example/paper.pdf' }]);
});

test('sigue al siguiente destino cuando el primero no abre', () => {
  const attempted = [];
  const opened = openFirstTarget([
    { mode: 'external', url: 'https://blocked.example/paper.pdf' },
    { mode: 'external', url: 'https://publisher.example/paper' },
  ], {
    inline: () => true,
    external: (url) => {
      attempted.push(url);
      return url === 'https://publisher.example/paper';
    },
  });

  assert.equal(opened, true);
  assert.deepEqual(attempted, [
    'https://blocked.example/paper.pdf',
    'https://publisher.example/paper',
  ]);
});

// El visor decía «no hay PDF de acceso abierto» cuando lo que pasaba era que
// el host no se dejaba enmarcar. Son dos cosas distintas y hay que poder
// contarlas por separado.
test('separa el PDF que existe del PDF que se puede enmarcar', () => {
  assert.deepEqual(pdfLinksForPaper({ pdfUrl: 'https://europepmc.org/articles/PMC1?pdf=render' }), {
    fullTextUrl: 'https://europepmc.org/articles/PMC1?pdf=render',
    embedUrl: '',
  });

  assert.deepEqual(pdfLinksForPaper({
    pdfUrl: 'https://europepmc.org/articles/PMC1?pdf=render',
    arxivId: '2101.00001',
  }), {
    fullTextUrl: 'https://europepmc.org/articles/PMC1?pdf=render',
    embedUrl: 'https://arxiv.org/pdf/2101.00001',
  });

  assert.deepEqual(pdfLinksForPaper({}), { fullTextUrl: '', embedUrl: '' });
});

test('avisa de que no abrió nada cuando ningún destino responde', () => {
  assert.equal(openFirstTarget([{ mode: 'external', url: 'https://blocked.example/p.pdf' }], {
    inline: () => true,
    external: () => false,
  }), false);
  assert.equal(openFirstTarget([], { inline: () => true, external: () => true }), false);
});
