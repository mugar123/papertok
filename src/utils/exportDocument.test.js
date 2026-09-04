import assert from 'node:assert/strict';
import test from 'node:test';
import {
  documentCopy,
  exportFileName,
  numberAnnotations,
  summarizeExport,
} from './exportDocument.js';

test('annotations are grouped by paragraph in document order', () => {
  const sections = [{ id: 's1' }, { id: 's2' }];
  const { byParagraph, numbered } = numberAnnotations(sections, [
    { id: 'c', sectionId: 's2', paragraphIndex: 0, quote: 'ccc', note: 'tercera' },
    { id: 'a', sectionId: 's1', paragraphIndex: 0, quote: 'aaa', note: 'primera' },
    { id: 'b', sectionId: 's1', paragraphIndex: 1, quote: 'bbb', note: 'segunda' },
  ]);
  assert.deepEqual(numbered.map(item => item.id), ['a', 'b', 'c']);
  assert.equal(byParagraph.get('s1:0')[0].id, 'a');
  assert.equal(byParagraph.get('s2:0')[0].id, 'c');
});

test('a bare highlight is grouped but not numbered', () => {
  const { byParagraph, numbered } = numberAnnotations([{ id: 's1' }], [
    { id: 'mark', sectionId: 's1', paragraphIndex: 0, quote: 'aaa' },
  ]);
  assert.equal(numbered.length, 0);
  assert.equal(byParagraph.get('s1:0').length, 1);
});

test('the file is named after the paper, safely', () => {
  assert.equal(
    exportFileName({ title: 'Correladores & el 100% del ruido_medido' }, 'es'),
    'correladores-el-100-del-ruido-medido-en-simple.tex',
  );
  assert.equal(exportFileName({ title: 'Ñandú en Ávila' }, 'en'), 'nandu-en-avila-plain-words.tex');
  // A title made entirely of punctuation must still produce a filename.
  assert.equal(exportFileName({ title: '///' }, 'es'), 'paper-en-simple.tex');
  assert.equal(exportFileName({}, 'es'), 'paper-en-simple.tex');
});

test('the file name can carry another extension for the other formats', () => {
  assert.equal(
    exportFileName({ title: 'Ñandú en Ávila' }, 'en', 'pdf'),
    'nandu-en-avila-plain-words.pdf',
  );
  assert.equal(exportFileName({}, 'es', 'pdf'), 'paper-en-simple.pdf');
});

test('the card can count what it is about to export without building it', () => {
  assert.deepEqual(summarizeExport([
    { quote: 'a', kind: 'user' },
    { quote: 'b', kind: 'user', note: 'x' },
    { quote: 'c', kind: 'ai', note: 'y' },
    { quote: '', kind: 'user' },
  ]), { marks: 1, mine: 1, ai: 1 });
});

test('documentCopy hands each language its own strings, and defaults to Spanish', () => {
  assert.match(documentCopy('en').provenance, /Rewritten by PaperTok/);
  assert.match(documentCopy('es').provenance, /Reescrito por PaperTok/);
  assert.match(documentCopy('fr').provenance, /Reescrito por PaperTok/);
  assert.equal(documentCopy('es').levels.university, 'universitario');
});
