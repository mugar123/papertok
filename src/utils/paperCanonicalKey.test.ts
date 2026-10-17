import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalArxivIdOf, canonicalDoiOf } from './paperCanonicalKey.ts';

// The alias table (interactionAliases.js) matches a paper across providers by
// these spellings, so each block asserts one way the same paper arrives.

test('a DOI arriving dressed differently converges on one spelling', () => {
  for (const form of [
    '10.1234/AbC.5',
    'doi:10.1234/abc.5',
    'DOI: 10.1234/ABC.5',
    'https://doi.org/10.1234/abc.5',
    'http://dx.doi.org/10.1234/Abc.5',
  ]) {
    assert.equal(canonicalDoiOf(form), '10.1234/abc.5', form);
    assert.equal(canonicalDoiOf({ doi: form }), '10.1234/abc.5', form);
  }
});

test('externalIds carry the same weight as the top-level fields', () => {
  assert.equal(canonicalDoiOf({ externalIds: { DOI: '10.5555/xyz' } }), '10.5555/xyz');
  assert.equal(canonicalArxivIdOf({ externalIds: { ArXiv: '2401.12345v2' } }), '2401.12345');
});

test('the arXiv version is stripped: v1 and v17 are the same paper', () => {
  for (const form of ['2401.12345', '2401.12345v1', '2401.12345v17']) {
    assert.equal(canonicalArxivIdOf({ arxivId: form }), '2401.12345', form);
  }
});

test('old-style arXiv ids keep their category and lose their version', () => {
  for (const form of ['hep-th/9901001', 'hep-th/9901001v2', 'arXiv:hep-th/9901001v2',
    'https://arxiv.org/abs/hep-th/9901001v2', 'math.GT/0309136v1']) {
    assert.match(canonicalArxivIdOf(form)!, /^(hep-th\/9901001|math\.gt\/0309136)$/, form);
  }
});

test('arXiv URLs and pdf links normalize like bare ids', () => {
  for (const form of ['https://arxiv.org/abs/2401.12345v3', 'arxiv.org/pdf/2401.12345v3.pdf',
    'https://export.arxiv.org/abs/2401.12345', 'arXiv:2401.12345']) {
    assert.equal(canonicalArxivIdOf(form), '2401.12345', form);
  }
});

test('anything that is not a DOI or an arXiv id gives null', () => {
  for (const value of [null, undefined, '', '   ', {}, 'not-a-doi', '10.12/x', 'doi:banana',
    'https://example.com/paper/1', `10.1234/a${String.fromCharCode(7)}b`]) {
    assert.equal(canonicalDoiOf(value), null, JSON.stringify(value));
  }
  for (const value of [null, undefined, '', {}, '99', 'arxiv:v2', 'pmid:38012345']) {
    assert.equal(canonicalArxivIdOf(value), null, JSON.stringify(value));
  }
});
