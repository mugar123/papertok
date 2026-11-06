import assert from 'node:assert/strict';
import test from 'node:test';
import { citationFacts, jatsTex, latexmlTex } from './full-text.ts';

// Captured: the array alttext (1512.03385), the Attention formula and the
// "CoRR, abs/1409.0473, 2014." line (1706.03762), and the Tian citation
// (PMC10756882). Synthetic: the \mbox, \mboxed and \lx@sectionsign formulas,
// the blank and null inputs, the tex-math wrappers, the BERT line and the
// citation with no year.

test('rewrites the three LaTeXML spellings KaTeX refuses, and leaves the rest', () => {
  assert.equal(
    latexmlTex('\\left[\\begin{array}[]{c}\\text{3$\\times$3, 64}\\end{array}\\right]'),
    '\\left[\\begin{array}{c}\\text{3$\\times$3, 64}\\end{array}\\right]',
  );
  assert.equal(latexmlTex('\\mbox{if }x>0'), '\\text{if }x>0');
  assert.equal(latexmlTex('\\mboxed{x}'), '\\mboxed{x}');
  assert.equal(latexmlTex('\\lx@sectionsign 3'), '\\S 3');
  assert.equal(latexmlTex('\\mathrm{Attention}(Q,K,V)'), '\\mathrm{Attention}(Q,K,V)');
  assert.equal(latexmlTex('  '), undefined);
  assert.equal(latexmlTex(null), undefined);
});

test('takes the formula out of a JATS tex-math document and its delimiters', () => {
  assert.equal(
    jatsTex('\\documentclass[12pt]{minimal}\\usepackage{amsmath}\\begin{document}$$E = mc^2$$\\end{document}'),
    'E = mc^2',
  );
  assert.equal(jatsTex('\\[ \\frac{a}{b} \\]'), '\\frac{a}{b}');
  assert.equal(jatsTex('x_i'), 'x_i');
  assert.equal(jatsTex(''), undefined);
});

test('reads year, DOI and arXiv id from a citation line, not mistaking an arXiv id for a year', () => {
  assert.deepEqual(
    citationFacts('Jacob Devlin et al. BERT: Pre-training of deep bidirectional transformers. In NAACL, 2019. arXiv:1810.04805'),
    { year: '2019', doi: undefined, arxiv: '1810.04805' },
  );
  assert.deepEqual(
    citationFacts('Tian J. Reversible data embedding using a difference expansion. IEEE Trans. 2003;13(8):890–896. doi: 10.1109/TCSVT.2003.815962.'),
    { year: '2003', doi: '10.1109/TCSVT.2003.815962', arxiv: undefined },
  );
  assert.deepEqual(citationFacts('CoRR, abs/1409.0473, 2014.'), { year: '2014', doi: undefined, arxiv: '1409.0473' });
  assert.deepEqual(citationFacts('In Proceedings, pages 3-10.'), { year: undefined, doi: undefined, arxiv: undefined });
});
