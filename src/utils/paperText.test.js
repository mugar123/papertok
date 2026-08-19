import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPaperText, displayAuthorName } from './paperText.js';

test('numeric sub/sup tags become unicode scripts glued to their formula', () => {
  assert.equal(
    cleanPaperText('The Resonating Valence Bond State in La <sub>2</sub> CuO <sub>4</sub> and Superconductivity'),
    'The Resonating Valence Bond State in La₂CuO₄ and Superconductivity',
  );
  assert.equal(cleanPaperText('H <sub>2</sub> O and E=mc <sup>2</sup> today'), 'H₂O and E=mc² today');
  assert.equal(cleanPaperText('CO <sub>2</sub>'), 'CO₂');
});

test('non-numeric scripts and other tags keep their content, spaced', () => {
  assert.equal(cleanPaperText('M <sub>BH</sub> relation'), 'M BH relation');
  assert.equal(cleanPaperText('a <i>very</i> nice <b>title</b>'), 'a very nice title');
});

test('entities decode and whitespace collapses', () => {
  assert.equal(cleanPaperText('Waves &amp; particles&nbsp;&nbsp;here'), 'Waves & particles here');
});

test('latex passes through untouched', () => {
  assert.equal(
    cleanPaperText('A $z \\sim$ 6.2 Quasar on the M$_{\\rm BH}$ relation'),
    'A $z \\sim$ 6.2 Quasar on the M$_{\\rm BH}$ relation',
  );
});

test('clean text is returned as-is', () => {
  assert.equal(cleanPaperText('Plain title with 2 < 3 kept? no tag here'), 'Plain title with 2 < 3 kept? no tag here');
  assert.equal(cleanPaperText(null), '');
  assert.equal(cleanPaperText(undefined), '');
});

test('surname-comma-initials flips, everything else stays', () => {
  assert.equal(displayAuthorName('Do, T.'), 'T. Do');
  assert.equal(displayAuthorName('Van Damme, J. C.'), 'J. C. Van Damme');
  // Full given names are not unambiguous initials — untouched.
  assert.equal(displayAuthorName('Kuehn, Christian'), 'Kuehn, Christian');
  assert.equal(displayAuthorName('P. W. Anderson'), 'P. W. Anderson');
  assert.equal(displayAuthorName('  Gan   Luo '), 'Gan Luo');
  assert.equal(displayAuthorName(null), '');
});
