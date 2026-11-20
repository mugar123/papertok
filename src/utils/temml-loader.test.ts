import test from 'node:test';
import assert from 'node:assert/strict';
import temml from 'temml';
import { temmlMarkup } from './temml-loader.ts';

test('a formula that links to or names an equation is left to the source MathML', () => {
  assert.equal(temmlMarkup(temml, 'x = \\eqref{eq:1} + 1', false), null);
  assert.equal(temmlMarkup(temml, 'y = \\ref{eq:1}', false), null);
  assert.equal(temmlMarkup(temml, '\\begin{equation}x\\label{ft-body}\\end{equation}', true), null);
  assert.match(temmlMarkup(temml, '\\bar{\\beta}_i = N\\beta_i', false) ?? '', /^<math/);
});
